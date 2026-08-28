# SPDX-License-Identifier: Apache-2.0
"""Model catalog, assembled from the ``rapid-mlx`` CLI.

Backed by three subprocess calls: ``models --json`` (every alias),
``models --cached --json`` (what is on disk) and ``rm <org/repo> --yes``.
The first two emit only JSON on stdout; ``rm`` emits human text, so its
exit code is the contract.

Two facts from the payloads drive most of the logic, and both are easy to
get wrong:

* **Only the ``text`` bucket is chat-capable.** ``video-gen`` and
  ``image-gen`` aliases have no ``stream_chat``, so
  ``/v1/chat/completions`` on one is an ``AttributeError``.
  ``flux2-klein-4b`` can be present, cached and ``state: "ok"`` and is
  still not a chat model.
* **``state: "ok"`` is not "present".** A cached row can be ``incomplete``
  — a partial download. Treating that as cached hands the engine a
  snapshot it cannot load, surfacing minutes later as a start failure
  rather than immediately as "not downloaded".
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import signal
import time
from dataclasses import dataclass, field

# Both calls are sub-second on a healthy install (the catalog reads a
# checked-in manifest, the scan walks the HF cache), so this only keeps a
# wedged CLI from hanging an HTTP request indefinitely.
_SUBPROCESS_TIMEOUT_S = 30.0

# Removal unlinks every blob in a snapshot — not sub-second for a 60 GB
# model on a slow volume — but still bounded.
_REMOVE_TIMEOUT_S = 300.0

# ``org/repo``. Applied before the value becomes an argv token: an
# ``hf_path`` beginning with ``-`` would be parsed by the CLI as a flag.
_HF_PATH_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$")

# The alias list only changes when `rapid-mlx` itself is upgraded, which
# cannot happen under a running supervisor, so it is cached for the whole
# process. The disk scan changes whenever a download lands, hence a TTL.
_CACHED_SCAN_TTL_S = 5.0


class CatalogError(RuntimeError):
    """The ``rapid-mlx`` CLI could not be queried."""


class RemovalError(RuntimeError):
    """A cached model could not be removed."""


@dataclass
class ModelEntry:
    """One chat-capable alias, with its on-disk state merged in."""

    alias: str
    hf_path: str
    size_bytes: int | None
    cached: bool
    cached_bytes: int | None = None
    tool_call_parser: str | None = None
    reasoning_parser: str | None = None
    is_text_only: bool = False

    def to_dict(self) -> dict:
        return {
            "alias": self.alias,
            "hf_path": self.hf_path,
            "size_bytes": self.size_bytes,
            "cached": self.cached,
            "cached_bytes": self.cached_bytes,
            "tool_call_parser": self.tool_call_parser,
            "reasoning_parser": self.reasoning_parser,
            "is_text_only": self.is_text_only,
        }


@dataclass
class _CachedScan:
    """Memoised result of the disk scan."""

    at: float
    by_repo: dict[str, dict] = field(default_factory=dict)


class ModelCatalog:
    """Reads the model catalog by shelling out to ``rapid-mlx``."""

    def __init__(self, binary: str) -> None:
        self._binary = binary
        self._available: dict | None = None
        self._cached: _CachedScan | None = None
        # Without this, N concurrent page loads on a cold cache each spawn
        # their own pair of subprocesses.
        self._lock = asyncio.Lock()

    async def _run(
        self, args: list[str], *, timeout: float
    ) -> tuple[int, str, str]:
        """Run the CLI to completion. Returns ``(code, stdout, stderr)``."""
        try:
            process = await asyncio.create_subprocess_exec(
                self._binary,
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                # Own process group so a timeout can kill the whole tree.
                # Killing only the leader leaves children holding the
                # stdout pipe open, and asyncio waits for those pipes — so
                # the "timeout" would still block for the full runtime.
                start_new_session=True,
            )
        except OSError as exc:
            raise CatalogError(f"could not run {self._binary}: {exc}") from exc

        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(), timeout=timeout
            )
        except asyncio.TimeoutError as exc:
            # Kill rather than leave it: an abandoned scan keeps walking
            # the cache directory and competes for I/O with the retry.
            await self._kill_tree(process)
            raise CatalogError(
                f"`{' '.join(args)}` timed out after {timeout:.0f}s"
            ) from exc

        assert process.returncode is not None
        return (
            process.returncode,
            stdout.decode("utf-8", errors="replace"),
            stderr.decode("utf-8", errors="replace"),
        )

    async def _run_json(self, args: list[str]) -> dict:
        code, stdout, stderr = await self._run(args, timeout=_SUBPROCESS_TIMEOUT_S)

        if code != 0:
            raise CatalogError(
                f"`{' '.join(args)}` failed (exit {code}): {stderr.strip()[:400]}"
            )

        try:
            return json.loads(stdout)
        except ValueError as exc:
            raise CatalogError(f"`{' '.join(args)}` did not emit JSON") from exc

    @staticmethod
    async def _kill_tree(process: asyncio.subprocess.Process) -> None:
        """SIGKILL the timed-out query and everything it spawned."""
        try:
            os.killpg(os.getpgid(process.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            with contextlib.suppress(ProcessLookupError):
                process.kill()
        with contextlib.suppress(Exception):
            await process.wait()

    async def _available_payload(self) -> dict:
        if self._available is None:
            self._available = await self._run_json(["models", "--json"])
        return self._available

    async def _cached_by_repo(self, *, force: bool = False) -> dict[str, dict]:
        now = time.monotonic()
        if (
            not force
            and self._cached is not None
            and now - self._cached.at < _CACHED_SCAN_TTL_S
        ):
            return self._cached.by_repo

        payload = await self._run_json(["models", "--cached", "--json"])
        by_repo: dict[str, dict] = {}
        for row in payload.get("cached", []):
            repo = row.get("repo")
            # Only fully-materialised snapshots count: an "incomplete" row
            # is a partial download, and calling it cached makes a switch
            # fail minutes later inside the engine instead of here.
            if repo and row.get("state") == "ok":
                by_repo[repo] = row

        self._cached = _CachedScan(at=now, by_repo=by_repo)
        return by_repo

    def invalidate_cache(self) -> None:
        """Force the next disk scan to re-run, after a download or removal
        changes what is present."""
        self._cached = None

    async def list_chat_models(self, *, force: bool = False) -> list[ModelEntry]:
        """Chat-capable aliases, with on-disk state merged in.

        Non-text modalities are excluded rather than flagged: the only
        action in this picker is "load for chat", so they would be traps.
        """
        async with self._lock:
            available = await self._available_payload()
            cached = await self._cached_by_repo(force=force)

        entries: list[ModelEntry] = []
        for row in available.get("text", []):
            alias = row.get("alias")
            hf_path = row.get("hf_path")
            if not alias or not hf_path:
                continue
            # Matched on hf_path, not alias: a cached row carries
            # ``alias: null`` when the repo is not in the registry, so an
            # alias-keyed join would silently drop entries.
            hit = cached.get(hf_path)
            entries.append(
                ModelEntry(
                    alias=alias,
                    hf_path=hf_path,
                    size_bytes=row.get("size_bytes"),
                    cached=hit is not None,
                    cached_bytes=hit.get("size_bytes") if hit else None,
                    tool_call_parser=row.get("tool_call_parser"),
                    reasoning_parser=row.get("reasoning_parser"),
                    is_text_only=bool(row.get("is_text_only")),
                )
            )

        # Downloaded first, then alphabetical: on a 179-alias catalog the
        # handful the user has is what they want to reach.
        entries.sort(key=lambda e: (not e.cached, e.alias))
        return entries

    async def is_known_chat_alias(self, alias: str) -> bool:
        """Whether ``alias`` is a chat model this install knows.

        Every alias arriving over HTTP is checked here before it reaches a
        subprocess argument: passing the string through would let a remote
        caller name an arbitrary ``org/repo``.
        """
        return await self.chat_profile(alias) is not None

    async def chat_profile(self, alias: str) -> dict | None:
        """The catalog row for a chat alias, or ``None`` if unknown.

        Returns the row rather than a bool so callers needing the download
        size do not re-list. ``size_bytes`` is ``None`` for repos missing
        from the size manifest (a real case:
        ``google/embeddinggemma-300m-6bit``) and must be treated as
        unknown, never as zero.
        """
        async with self._lock:
            available = await self._available_payload()
        for row in available.get("text", []):
            if row.get("alias") == alias:
                return row
        return None

    async def remove(self, alias: str) -> int | None:
        """Delete ``alias``'s snapshot from the HF cache.

        Returns the bytes freed, or ``None`` when unknown. Raises
        :class:`RemovalError` if the CLI refused.

        ``rm`` is passed the catalog's ``hf_path``, never the alias: the
        CLI scans for ``models--<owner>--<repo>``, which a bare alias
        cannot match, and looking the alias up first means the argv token
        is one this install published rather than one a caller chose.

        Size is measured before the delete, from the cached scan — ``rm``
        prints a rounded human string like ``Freed 3.1G``.
        """
        profile = await self.chat_profile(alias)
        if profile is None:
            raise RemovalError(f"unknown chat model alias: {alias}")

        hf_path = profile.get("hf_path")
        if not isinstance(hf_path, str) or not _HF_PATH_RE.match(hf_path):
            # A malformed manifest row, but still a string on its way to argv.
            raise RemovalError(f"{alias} has no usable repository id")

        async with self._lock:
            cached = await self._cached_by_repo()
        hit = cached.get(hf_path)
        if hit is None:
            # Reported rather than ignored: the row is already gone, but
            # claiming to have freed something would be wrong.
            raise RemovalError(f"{alias} is not downloaded")
        freed = hit.get("size_bytes")

        code, stdout, stderr = await self._run(
            ["rm", hf_path, "--yes"], timeout=_REMOVE_TIMEOUT_S
        )
        # The disk changed either way: a partial failure may still have
        # unlinked some of the snapshot.
        self.invalidate_cache()

        if code != 0:
            detail = (stderr.strip() or stdout.strip())[:400]
            raise RemovalError(detail or f"`rm` exited with code {code}")

        return freed if isinstance(freed, int) else None
