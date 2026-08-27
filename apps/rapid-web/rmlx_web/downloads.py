# SPDX-License-Identifier: Apache-2.0
"""Model downloads, driven through ``rapid-mlx pull``.

Progress is **not** scraped from tqdm. ``rapid-mlx pull`` emits a
machine-readable heartbeat on stdout whenever stdout is not a TTY::

      [bytes] 5750583/649378984

``vllm_mlx/_mirror.py`` documents this as a contract the desktop app's
progress parser already depends on, and picks the mode from
``isatty()`` alone — a captured pipe always gets the machine form. Since
this module captures stdout, the heartbeat is guaranteed.

Interleaved with it are human status lines (``[3/11] config.json R2``),
which are ignored. The authoritative completion signal is the process
exit code, not any line of output: the pull prints a summary on success,
but a partial transfer that failed can print status lines too.

Why downloads are gated at all — the endpoint that reaches this module
is remotely reachable the moment a tunnel is attached, and a download is
the one operation here that consumes an unbounded amount of somebody
else's disk. Three gates, all enforced by the caller in ``app.py``:
off unless enabled, refused unless the size is known and fits, and
restricted to catalog aliases.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import re
import shutil
import signal
import time
from dataclasses import dataclass, field
from enum import Enum

# Free space that must remain after the download completes. A disk
# filled to the last byte takes the whole Mac down with it, not just
# this feature — the OS needs room for swap and the engine writes a
# Metal shader cache on first load.
DISK_HEADROOM_BYTES = 10 * 1024**3

# HuggingFace stages a blob then moves it into place, so the peak
# footprint exceeds the final size. 1.15 is a rough allowance; it does
# not need to be exact because DISK_HEADROOM_BYTES dominates.
_TRANSFER_OVERHEAD = 1.15

# ``  [bytes] 5750583/649378984``
_BYTES_RE = re.compile(r"^\s*\[bytes\]\s+(\d+)\s*/\s*(\d+)\s*$")

# Grace period between SIGTERM and SIGKILL on cancel. huggingface_hub
# unwinds a partial blob on the way out; killing instantly strands an
# ``.incomplete`` file that nothing else collects until the next pull of
# the same repo reaps it.
_TERM_GRACE_S = 10.0

_OUTPUT_TAIL_LINES = 40


class DownloadState(str, Enum):
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"
    CANCELLED = "cancelled"


class DownloadError(RuntimeError):
    """A download could not be started."""


@dataclass
class DownloadJob:
    """One in-flight or finished pull."""

    alias: str
    total_bytes: int | None
    state: DownloadState = DownloadState.RUNNING
    done_bytes: int = 0
    detail: str | None = None
    started_at: float = field(default_factory=time.monotonic)

    def to_dict(self) -> dict:
        # The denominator comes from the pull's own heartbeat once it
        # starts reporting, and from the size manifest before that. The
        # two can disagree slightly (the manifest is a snapshot), so the
        # live value wins to keep the bar monotonic.
        return {
            "alias": self.alias,
            "state": self.state.value,
            "done_bytes": self.done_bytes,
            "total_bytes": self.total_bytes,
            "detail": self.detail,
        }


def free_disk_bytes(path: str | None = None) -> int:
    """Bytes available on the filesystem holding the HF cache.

    Measured where the download will actually land, not on ``/``: a
    ``HF_HOME`` on an external volume is common, and checking the wrong
    filesystem gives an answer that is confidently wrong in either
    direction.
    """
    target = path or _hf_cache_root()
    # Walk up to the nearest existing ancestor — the cache directory may
    # not exist yet on a fresh install.
    while target and not os.path.exists(target):
        parent = os.path.dirname(target)
        if parent == target:
            break
        target = parent
    return shutil.disk_usage(target or "/").free


def _hf_cache_root() -> str:
    for var in ("HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE"):
        value = os.environ.get(var)
        if value:
            return value
    hf_home = os.environ.get("HF_HOME")
    if hf_home:
        return os.path.join(hf_home, "hub")
    return os.path.expanduser("~/.cache/huggingface/hub")


def check_disk_budget(size_bytes: int | None) -> str | None:
    """Reject a download that does not fit. Returns a reason, or None.

    **Fails closed on an unknown size.** ``model_sizes.json`` has no
    entry for every repo (``size_bytes`` returns ``None`` for e.g.
    ``google/embeddinggemma-300m-6bit``), and "unknown" must not be read
    as "small". Guessing here is how a publicly reachable endpoint fills
    the host's disk, so an unmeasurable model is refused and the user is
    told to pull it from the Mac instead.
    """
    if not size_bytes or size_bytes <= 0:
        return (
            "the download size for this model is unknown, so it cannot be "
            "checked against free space. Pull it from the Mac instead."
        )

    required = int(size_bytes * _TRANSFER_OVERHEAD) + DISK_HEADROOM_BYTES
    free = free_disk_bytes()
    if free < required:
        return (
            f"not enough free space: this needs about {_gib(required)} "
            f"(including {_gib(DISK_HEADROOM_BYTES)} headroom) "
            f"but only {_gib(free)} is available."
        )
    return None


def _gib(value: int) -> str:
    return f"{value / 1024**3:.1f} GiB"


def parse_progress(line: str) -> tuple[int, int] | None:
    """Extract ``(done, total)`` from a heartbeat line, if it is one."""
    match = _BYTES_RE.match(line)
    if not match:
        return None
    return int(match.group(1)), int(match.group(2))


class DownloadManager:
    """Runs at most one ``rapid-mlx pull`` at a time.

    One at a time is a policy choice, not a limitation: concurrent
    multi-GB pulls contend for the same bandwidth and disk, so two
    together finish no sooner than two in sequence while doubling the
    peak disk footprint — and the footprint is what the budget check
    above is defending.
    """

    def __init__(self, binary: str) -> None:
        self._binary = binary
        self._job: DownloadJob | None = None
        self._process: asyncio.subprocess.Process | None = None
        self._task: asyncio.Task | None = None
        self._output_tail: list[str] = []
        self._lock = asyncio.Lock()
        # Bumped on every state change so the SSE endpoint can wait
        # instead of polling on a timer.
        self._changed = asyncio.Event()

    @property
    def job(self) -> DownloadJob | None:
        return self._job

    def is_running(self) -> bool:
        return self._job is not None and self._job.state is DownloadState.RUNNING

    async def wait_for_change(self, timeout: float) -> None:
        """Block until the job changes, or ``timeout`` elapses."""
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(self._changed.wait(), timeout=timeout)
        self._changed.clear()

    def _notify(self) -> None:
        self._changed.set()

    async def start(self, alias: str, *, total_bytes: int | None) -> DownloadJob:
        async with self._lock:
            if self.is_running():
                raise DownloadError(
                    f"a download is already running ({self._job.alias}); "
                    "wait for it to finish or cancel it"
                )

            self._job = DownloadJob(alias=alias, total_bytes=total_bytes)
            self._output_tail = []

            try:
                process = await asyncio.create_subprocess_exec(
                    self._binary,
                    "pull",
                    alias,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                    # Own process group so cancel reaches the whole tree.
                    # The pull spawns transfer workers; signalling only
                    # the leader leaves them downloading with no parent.
                    start_new_session=True,
                )
            except OSError as exc:
                self._job.state = DownloadState.FAILED
                self._job.detail = str(exc)
                self._notify()
                raise DownloadError(f"could not run {self._binary}: {exc}") from exc

            self._process = process
            self._task = asyncio.create_task(self._supervise(process))
            self._notify()
            return self._job

    async def _supervise(self, process: asyncio.subprocess.Process) -> None:
        """Read progress until the child exits, then record the outcome."""
        assert process.stdout is not None
        job = self._job

        while True:
            try:
                raw = await process.stdout.readline()
            except (ValueError, OSError):
                # An over-long line without a newline raises ValueError.
                # Stop reading rather than kill the drain: leaving the
                # pipe unread would block the child on its next write.
                break
            if not raw:
                break

            line = raw.decode("utf-8", errors="replace").rstrip()
            if not line:
                continue

            progress = parse_progress(line)
            if progress is not None and job is not None:
                done, total = progress
                # Never let the bar go backwards. Workers heartbeat
                # concurrently, so a slightly stale line can arrive after
                # a fresher one.
                job.done_bytes = max(job.done_bytes, done)
                if total > 0:
                    job.total_bytes = total
                self._notify()
                continue

            self._output_tail.append(line)
            if len(self._output_tail) > _OUTPUT_TAIL_LINES:
                del self._output_tail[:-_OUTPUT_TAIL_LINES]

        code = await process.wait()

        if job is not None:
            if job.state is DownloadState.CANCELLED:
                # Already recorded by cancel(); a cancelled pull exits
                # non-zero, which must not be relabelled as a failure.
                pass
            elif code == 0:
                job.state = DownloadState.DONE
                # Snap to 100%: the last heartbeat can land slightly
                # short of the total, leaving a bar stuck at 99%.
                if job.total_bytes:
                    job.done_bytes = job.total_bytes
            else:
                job.state = DownloadState.FAILED
                job.detail = self._tail_text() or f"pull exited with code {code}"

        self._process = None
        self._notify()

    def _tail_text(self, lines: int = 6) -> str:
        return " | ".join(self._output_tail[-lines:])

    async def cancel(self) -> bool:
        """Stop the running pull. Returns False if none was running."""
        async with self._lock:
            process = self._process
            job = self._job
            if process is None or job is None or job.state is not DownloadState.RUNNING:
                return False

            # Mark before signalling so _supervise does not race and
            # relabel the non-zero exit as a failure.
            job.state = DownloadState.CANCELLED
            job.detail = "cancelled"
            self._notify()

            try:
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
            return True

    async def shutdown(self) -> None:
        """Stop any running pull at process exit.

        A download left running past the supervisor would keep writing
        to the cache with nothing watching it, and the user has no way
        to stop it short of finding the PID.
        """
        await self.cancel()
        if self._task is not None:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
            self._task = None
