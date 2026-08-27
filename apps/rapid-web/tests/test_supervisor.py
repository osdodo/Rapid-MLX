# SPDX-License-Identifier: Apache-2.0
"""Tests for the engine supervisor.

Real ``rapid-mlx serve`` is never spawned here; the child is a short
Python script. That keeps the tests honest about process mechanics
(signals, pipe draining, exit codes) without needing MLX or a model.
"""

from __future__ import annotations

import sys

import pytest

from rmlx_web import supervisor
from rmlx_web.supervisor import (
    AttachedEngine,
    ChildState,
    EngineSupervisor,
    SupervisorError,
    find_rapid_mlx_binary,
    pick_free_port,
)


class TestBinaryResolution:
    def test_explicit_path_wins(self):
        assert find_rapid_mlx_binary("/usr/bin/true") == "/usr/bin/true"

    def test_env_override_is_used(self, monkeypatch):
        monkeypatch.setenv("RAPID_MLX_BIN", "/opt/custom/rapid-mlx")
        assert find_rapid_mlx_binary() == "/opt/custom/rapid-mlx"

    def test_missing_binary_raises_with_an_actionable_message(self, monkeypatch):
        monkeypatch.delenv("RAPID_MLX_BIN", raising=False)
        monkeypatch.setattr(supervisor.shutil, "which", lambda _: None)

        with pytest.raises(SupervisorError) as excinfo:
            find_rapid_mlx_binary()

        message = str(excinfo.value)
        assert "pip install rapid-mlx" in message
        assert "--rapid-mlx-bin" in message

    def test_non_executable_explicit_path_is_rejected(self, tmp_path):
        path = tmp_path / "not-executable"
        path.write_text("#!/bin/sh\n")
        path.chmod(0o644)

        with pytest.raises(SupervisorError):
            find_rapid_mlx_binary(str(path))


class TestPortAllocation:
    def test_returns_a_usable_port(self):
        port = pick_free_port()
        assert 1024 < port <= 65535

    def test_successive_calls_differ(self):
        # Not a guarantee the OS makes, but a same-port result twice in a
        # row would mean the socket is not actually being released.
        assert pick_free_port() != pick_free_port()


class TestSupervisorLifecycle:
    @pytest.mark.asyncio
    async def test_child_that_exits_immediately_reports_failure(self):
        # A child that never binds a port must be noticed by its exit,
        # not by waiting out the full readiness timeout — otherwise a bad
        # alias would look like a 15-minute hang.
        engine = EngineSupervisor(
            binary=sys.executable,
            api_key="k",
            ready_timeout_s=30.0,
        )

        with pytest.raises(SupervisorError) as excinfo:
            await _start_with_argv(
                engine,
                [sys.executable, "-c", "import sys; sys.exit(3)"],
            )

        assert "exited during startup" in str(excinfo.value)
        assert engine.status().state is ChildState.FAILED

    @pytest.mark.asyncio
    async def test_ready_timeout_is_reported_and_the_child_is_cleaned_up(self):
        engine = EngineSupervisor(
            binary=sys.executable,
            api_key="k",
            # Short deliberately: this test measures the timeout path, not
            # startup speed, and the child never becomes ready by design.
            ready_timeout_s=2.0,
        )

        with pytest.raises(SupervisorError) as excinfo:
            await _start_with_argv(
                engine,
                [sys.executable, "-c", "import time; time.sleep(60)"],
            )

        assert "did not become ready" in str(excinfo.value)
        assert engine.status().state is ChildState.FAILED
        # A half-started child still holds GPU memory; leaving it running
        # would make the next start contend for the device.
        assert engine._process is None

    @pytest.mark.asyncio
    async def test_stop_is_safe_when_nothing_was_started(self):
        engine = EngineSupervisor(binary=sys.executable, api_key="k")
        await engine.stop()
        assert engine.status().state is ChildState.STOPPED

    @pytest.mark.asyncio
    async def test_output_tail_is_bounded(self):
        engine = EngineSupervisor(
            binary=sys.executable,
            api_key="k",
            ready_timeout_s=2.0,
        )

        with pytest.raises(SupervisorError):
            await _start_with_argv(
                engine,
                [
                    sys.executable,
                    "-c",
                    "import sys\n"
                    "for i in range(1000): print('line', i, flush=True)\n"
                    "import time; time.sleep(30)",
                ],
            )

        # A long-running server logs every request; an unbounded tail
        # would grow without limit for the life of the process.
        assert len(engine.status().recent_output) <= 200

    @pytest.mark.asyncio
    async def test_base_url_is_none_until_ready(self):
        engine = EngineSupervisor(binary=sys.executable, api_key="k")
        assert engine.base_url is None


async def _start_with_argv(engine: EngineSupervisor, argv: list[str]) -> None:
    """Drive ``_start_locked`` with a substitute command line.

    The supervisor builds its own argv from the alias; these tests need a
    child that is not `rapid-mlx serve`, so the binary and args are
    swapped for a Python one-liner. Everything after the spawn — the
    readiness poll, the output drain, the failure teardown — is the real
    code path.
    """
    engine._binary = argv[0]
    engine._serve_args = argv[1:]

    original_exec = supervisor.asyncio.create_subprocess_exec

    async def patched(*_ignored_argv, **kwargs):
        return await original_exec(*argv, **kwargs)

    supervisor.asyncio.create_subprocess_exec = patched
    try:
        async with engine._lock:
            await engine._start_locked("fake-alias")
    finally:
        supervisor.asyncio.create_subprocess_exec = original_exec


class TestAttachedEngine:
    def test_reports_ready_and_refuses_switching(self):
        engine = AttachedEngine("http://127.0.0.1:8000/", api_key="k")

        assert engine.base_url == "http://127.0.0.1:8000"
        assert engine.status().state is ChildState.READY
        # Owning nothing means switching is structurally impossible, not
        # merely unimplemented — callers check the flag rather than
        # discovering it from an exception.
        assert engine.can_switch is False

    @pytest.mark.asyncio
    async def test_start_raises(self):
        engine = AttachedEngine("http://127.0.0.1:8000")
        with pytest.raises(SupervisorError):
            await engine.start("anything")
