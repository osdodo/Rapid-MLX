# SPDX-License-Identifier: Apache-2.0
"""Lifecycle of the supervised ``rapid-mlx serve`` child.

Why supervise at all, rather than telling the user to start ``rapid-mlx
serve`` themselves and pointing at it:

* **Switching models means restarting the engine.** There is no
  hot-swap; a different model is a different process. A page pointed
  straight at the engine would therefore break on every switch, because
  the port it was talking to no longer exists. Owning the child lets the
  external port stay fixed for the whole session while the child comes
  and goes underneath it. (This is the same argument issue #2370 makes
  for putting the proxy in the Swift layer, relocated to Python.)
* **Port choice.** The child gets an ephemeral port picked here, so
  running this alongside an existing ``rapid-mlx serve`` or the desktop
  app does not collide.

The child is driven as a **subprocess of the CLI**, not by importing
``vllm_mlx``. That is what keeps this package installable and testable
without the engine, and what makes it survive engine-internal
refactors: the contract is the documented command line.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import shutil
import signal
import socket
from dataclasses import dataclass, field
from enum import Enum

import httpx

# How long to wait for the child to answer /health/ready before giving
# up. A cold start compiles Metal shaders and may pull weights, so the
# ceiling is minutes, not seconds — the wrong value here shows up as a
# spurious "failed to start" on exactly the large models people most
# want to run.
DEFAULT_READY_TIMEOUT_S = 900.0

# Gap between readiness polls. The child is doing GPU work; polling it
# tightly buys nothing and shows up in its request log.
_READY_POLL_INTERVAL_S = 1.0

# Grace period between SIGTERM and SIGKILL when stopping the child.
# mlx releases GPU buffers on the way out; killing immediately can leave
# wired memory attributed to a dead process until the kernel reclaims it.
_TERM_GRACE_S = 10.0


class ChildState(str, Enum):
    """Coarse state of the supervised engine, as reported to the page."""

    STOPPED = "stopped"
    STARTING = "starting"
    READY = "ready"
    FAILED = "failed"


class SupervisorError(RuntimeError):
    """The child could not be started, or died during startup."""


@dataclass
class ChildStatus:
    """Snapshot handed to ``/api/status``.

    Deliberately a value object rather than a live view of the
    supervisor: the HTTP handler serialises it after the lock is
    released, so it must not be able to change underneath.
    """

    state: ChildState
    model: str | None = None
    port: int | None = None
    detail: str | None = None
    recent_output: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "state": self.state.value,
            "model": self.model,
            "port": self.port,
            "detail": self.detail,
        }


def find_rapid_mlx_binary(explicit: str | None = None) -> str:
    """Locate the ``rapid-mlx`` command.

    Checked in precedence order so a user with several installs (pip in
    a venv, Homebrew, a source checkout) can be explicit without editing
    their PATH.
    """
    if explicit:
        if os.path.isabs(explicit) and not os.access(explicit, os.X_OK):
            raise SupervisorError(f"not executable: {explicit}")
        return explicit

    env_override = os.environ.get("RAPID_MLX_BIN")
    if env_override:
        return env_override

    found = shutil.which("rapid-mlx") or shutil.which("rmlx")
    if not found:
        raise SupervisorError(
            "could not find the `rapid-mlx` command on PATH. Install it with "
            "`pip install rapid-mlx`, or pass --rapid-mlx-bin /path/to/rapid-mlx."
        )
    return found


def pick_free_port() -> int:
    """Ask the OS for an unused localhost port.

    Bind-then-close leaves a window in which something else could take
    the port before the child binds it. That race is accepted here: the
    alternative (hand the child an inherited socket) means coupling to
    the engine's internals, and a collision surfaces immediately as a
    startup failure rather than as silent misbehaviour.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class EngineSupervisor:
    """Owns at most one ``rapid-mlx serve`` child process."""

    # Owning the child is exactly what makes switching possible; the
    # attached variant below sets this False so the HTTP layer can
    # refuse up front instead of surfacing a mid-request exception.
    can_switch = True

    def __init__(
        self,
        *,
        binary: str,
        api_key: str,
        serve_args: list[str] | None = None,
        ready_timeout_s: float = DEFAULT_READY_TIMEOUT_S,
    ) -> None:
        self._binary = binary
        self._api_key = api_key
        self._serve_args = list(serve_args or [])
        self._ready_timeout_s = ready_timeout_s

        self._process: asyncio.subprocess.Process | None = None
        self._model: str | None = None
        self._port: int | None = None
        self._state = ChildState.STOPPED
        self._detail: str | None = None
        # Bounded tail of the child's output. Startup failures (a bad
        # alias, an OOM, a missing checkpoint) are explained in the
        # child's stderr and nowhere else, so the page needs some of it
        # to say anything useful. Bounded because a long-running server
        # logs every request.
        self._output_tail: list[str] = []
        self._drain_task: asyncio.Task | None = None
        # Serialises start/stop/switch. Two concurrent switch requests
        # would otherwise both spawn a child and leak one of them.
        self._lock = asyncio.Lock()

    @property
    def base_url(self) -> str | None:
        """Where the child is listening, or ``None`` if it is not."""
        if self._port is None or self._state is not ChildState.READY:
            return None
        return f"http://127.0.0.1:{self._port}"

    @property
    def api_key(self) -> str:
        return self._api_key

    def status(self) -> ChildStatus:
        return ChildStatus(
            state=self._state,
            model=self._model,
            port=self._port,
            detail=self._detail,
            recent_output=list(self._output_tail),
        )

    async def start(self, model: str) -> None:
        """Spawn the child for ``model`` and wait until it is ready."""
        async with self._lock:
            await self._stop_locked()
            await self._start_locked(model)

    async def stop(self) -> None:
        async with self._lock:
            await self._stop_locked()

    async def _start_locked(self, model: str) -> None:
        port = pick_free_port()
        argv = [
            self._binary,
            "serve",
            model,
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
        ] + self._serve_args

        env = dict(os.environ)
        # The child's bearer travels by environment, not argv. On macOS
        # `ps -axww` shows argv to any user on the system, while `ps eww`
        # gates environment behind same-UID-or-root. Same reasoning as
        # BearerSecret.swift's SECURITY NOTE, and the engine documents
        # RAPID_MLX_API_KEY as the supported form.
        env["RAPID_MLX_API_KEY"] = self._api_key

        self._state = ChildState.STARTING
        self._model = model
        self._port = port
        self._detail = None
        self._output_tail = []

        try:
            process = await asyncio.create_subprocess_exec(
                *argv,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                env=env,
                # Own process group: stopping the supervisor must take
                # the engine down with it. Without this, a Ctrl-C in the
                # terminal reaches only us and leaves a multi-GB model
                # resident with no owner.
                start_new_session=True,
            )
        except OSError as exc:
            self._state = ChildState.FAILED
            self._detail = str(exc)
            raise SupervisorError(f"failed to launch {self._binary}: {exc}") from exc

        self._process = process
        self._drain_task = asyncio.create_task(self._drain_output(process))

        try:
            await self._await_ready(process, port)
        except SupervisorError:
            self._state = ChildState.FAILED
            # Do not leave a half-started child behind: it may still be
            # holding GPU memory, and the next start would then contend
            # with it for the same device.
            await self._stop_locked(preserve_failure=True)
            raise

        self._state = ChildState.READY

    async def _await_ready(
        self, process: asyncio.subprocess.Process, port: int
    ) -> None:
        """Poll ``/health/ready`` until the engine finishes startup.

        ``/health/ready`` rather than ``/v1/models``: the engine returns
        200 from ``/v1/models`` as soon as FastAPI binds, which is before
        warmup and prefix-cache load. A request sent in that window
        competes with warmup and looks like a hang. ``/health/ready``
        answers 503 until lifespan startup is genuinely complete, which
        is the signal we actually want.
        """
        deadline = asyncio.get_running_loop().time() + self._ready_timeout_s
        url = f"http://127.0.0.1:{port}/health/ready"

        async with httpx.AsyncClient(timeout=5.0) as client:
            while True:
                if process.returncode is not None:
                    raise SupervisorError(
                        "the engine exited during startup "
                        f"(code {process.returncode}). "
                        f"Last output: {self._tail_text()}"
                    )
                if asyncio.get_running_loop().time() > deadline:
                    raise SupervisorError(
                        "the engine did not become ready within "
                        f"{self._ready_timeout_s:.0f}s. "
                        f"Last output: {self._tail_text()}"
                    )
                try:
                    response = await client.get(url)
                    if response.status_code == 200:
                        return
                except httpx.HTTPError:
                    # Connection refused is the normal case for most of
                    # this loop — the child has not bound yet.
                    pass
                await asyncio.sleep(_READY_POLL_INTERVAL_S)

    async def _drain_output(self, process: asyncio.subprocess.Process) -> None:
        """Continuously read the child's output into a bounded tail.

        This is not optional bookkeeping. The child's stdout is a pipe
        with a fixed kernel buffer; if nobody reads it, the child blocks
        on write once that buffer fills and the engine simply stops
        mid-generation. Draining is what keeps it alive.
        """
        assert process.stdout is not None
        while True:
            try:
                line = await process.stdout.readline()
            except (ValueError, OSError):
                # readline raises ValueError on an over-long line with no
                # newline; treat it as end of usable output rather than
                # killing the drain task and re-introducing the stall.
                break
            if not line:
                break
            text = line.decode("utf-8", errors="replace").rstrip()
            if text:
                self._output_tail.append(text)
                if len(self._output_tail) > 200:
                    del self._output_tail[:-200]

    def _tail_text(self, lines: int = 8) -> str:
        return " | ".join(self._output_tail[-lines:]) or "(no output)"

    async def _stop_locked(self, *, preserve_failure: bool = False) -> None:
        process = self._process
        if process is None:
            if not preserve_failure:
                self._state = ChildState.STOPPED
            return

        if process.returncode is None:
            try:
                # Signal the whole group, not just the child. The engine
                # spawns helpers, and `start_new_session` put them in a
                # group of their own; signalling only the leader would
                # orphan them.
                os.killpg(os.getpgid(process.pid), signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                with contextlib.suppress(ProcessLookupError):
                    process.terminate()

            try:
                await asyncio.wait_for(process.wait(), timeout=_TERM_GRACE_S)
            except asyncio.TimeoutError:
                try:
                    os.killpg(os.getpgid(process.pid), signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    with contextlib.suppress(ProcessLookupError):
                        process.kill()
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(process.wait(), timeout=_TERM_GRACE_S)

        if self._drain_task is not None:
            self._drain_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._drain_task
            self._drain_task = None

        self._process = None
        self._port = None
        if not preserve_failure:
            self._state = ChildState.STOPPED
            self._model = None


class AttachedEngine:
    """Stand-in for :class:`EngineSupervisor` in ``--attach`` mode.

    Presents the same surface so the HTTP layer does not branch, but
    owns nothing: the engine belongs to whoever started it. Model
    switching is therefore impossible here, and callers must check
    :attr:`can_switch` rather than discovering it from a failure.
    """

    can_switch = False

    def __init__(self, base_url: str, *, api_key: str | None = None) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key or ""

    @property
    def base_url(self) -> str | None:
        return self._base_url

    @property
    def api_key(self) -> str:
        return self._api_key

    def status(self) -> ChildStatus:
        # Reported as READY without probing: the caller asserted this
        # endpoint exists. A probe here would only move the failure from
        # the first chat request to startup, and would have to be
        # repeated anyway since an attached engine can go away at any
        # time.
        return ChildStatus(state=ChildState.READY, model=None, port=None)

    async def start(self, model: str) -> None:
        raise SupervisorError("cannot switch models in --attach mode")

    async def stop(self) -> None:
        return None
