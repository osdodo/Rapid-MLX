# SPDX-License-Identifier: Apache-2.0
"""Model catalog, assembled from the ``rapid-mlx`` CLI.

Two subprocess calls back this module:

* ``rapid-mlx models --json`` — every alias the install knows about,
  bucketed by modality. Static for the life of an install.
* ``rapid-mlx models --cached --json`` — what is actually on disk.
  Changes whenever a download lands or a model is removed.

Both emit **only** the JSON payload on stdout (the CLI suppresses its
staleness banner in JSON mode), which is what makes them parseable
rather than scraped.

Two facts from the payloads drive most of the logic here, and both are
easy to get wrong:

* **Only the ``text`` bucket is chat-capable.** ``video-gen`` and
  ``image-gen`` aliases have no ``stream_chat``, so
  ``/v1/chat/completions`` on one is an ``AttributeError``, and audio
  aliases are a different lane entirely. Offering them in a chat model
  picker is how a user ends up waiting out a multi-GB download for a
  model that dead-ends on first send. ``flux2-klein-4b`` is a live
  example: it can be present, cached and ``state: "ok"``, and is still
  not a chat model.
* **``state: "ok"`` is not the same as "present".** A cached row can be
  ``incomplete`` — a partial download, config.json plus some shards.
  Treating that as cached means "switch" hands the engine a snapshot it
  cannot load, and the failure surfaces minutes later as a start
  failure rather than immediately as "not downloaded".
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import signal
import time
from dataclasses import dataclass, field

# The catalog call is pure Python (it reads a checked-in manifest, no
# network), and the cached scan walks the HF cache directory. Both are
# sub-second on a healthy install, so a short ceiling is enough to keep
# a wedged CLI from hanging an HTTP request indefinitely.
_SUBPROCESS_TIMEOUT_S = 30.0

# The alias list only changes when the `rapid-mlx` package itself is
# upgraded, which cannot happen under a running supervisor. Cached for
# the whole process.
#
# The disk scan is different: a download landing changes it, so it
# carries a short TTL instead. The TTL is what makes repeated polling
# from the page cheap without going stale enough to notice.
_CACHED_SCAN_TTL_S = 5.0


class CatalogError(RuntimeError):
    """The ``rapid-mlx`` CLI could not be queried."""


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
        # Serialises refreshes. Without it, N concurrent page loads on a
        # cold cache each spawn their own pair of subprocesses.
        self._lock = asyncio.Lock()

    async def _run_json(self, args: list[str]) -> dict:
        try:
            process = await asyncio.create_subprocess_exec(
                self._binary,
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                # Own process group so a timeout can kill the whole tree.
                # Killing only the leader leaves its children holding the
                # stdout pipe open, and asyncio does not consider the
                # process finished until those pipes close — so the
                # "timeout" would still block for the child's full
                # runtime, which is exactly what the timeout exists to
                # prevent.
                start_new_session=True,
            )
        except OSError as exc:
            raise CatalogError(f"could not run {self._binary}: {exc}") from exc

        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(), timeout=_SUBPROCESS_TIMEOUT_S
            )
        except asyncio.TimeoutError as exc:
            # Kill rather than leave it: an abandoned scan keeps walking
            # the cache directory and competes for I/O with the retry.
            await self._kill_tree(process)
            raise CatalogError(
                f"`{' '.join(args)}` timed out after {_SUBPROCESS_TIMEOUT_S:.0f}s"
            ) from exc

        if process.returncode != 0:
            detail = stderr.decode("utf-8", errors="replace").strip()[:400]
            raise CatalogError(
                f"`{' '.join(args)}` failed (exit {process.returncode}): {detail}"
            )

        try:
            return json.loads(stdout.decode("utf-8", errors="replace"))
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
            # Only fully-materialised snapshots count. An "incomplete"
            # row is a partial download; calling it cached makes a switch
            # fail minutes later inside the engine instead of here.
            if repo and row.get("state") == "ok":
                by_repo[repo] = row

        self._cached = _CachedScan(at=now, by_repo=by_repo)
        return by_repo

    def invalidate_cache(self) -> None:
        """Force the next disk scan to re-run.

        Called after anything that changes what is on disk — a completed
        download, a removal — so the page does not keep showing a stale
        "not downloaded" for up to the TTL.
        """
        self._cached = None

    async def list_chat_models(self, *, force: bool = False) -> list[ModelEntry]:
        """Chat-capable aliases, with on-disk state merged in.

        Non-text modalities are excluded entirely rather than flagged:
        this list feeds a picker whose only action is "load for chat",
        and every non-text entry in it would be a trap.
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
            # ``alias: null`` whenever the repo is not in the registry,
            # so an alias-keyed join would silently drop entries.
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

        # Downloaded models first, then alphabetical. On a 179-alias
        # catalog the handful the user actually has is what they want to
        # reach, and burying those in an alphabetical wall makes the
        # picker useless on a phone.
        entries.sort(key=lambda e: (not e.cached, e.alias))
        return entries

    async def is_known_chat_alias(self, alias: str) -> bool:
        """Whether ``alias`` is a chat model this install knows.

        Every alias arriving over HTTP is checked against this before it
        reaches a subprocess argument. The alternative — passing the
        string through — would let a remote caller name an arbitrary
        ``org/repo``, which is a general-purpose fetch primitive rather
        than a model picker.
        """
        return await self.chat_profile(alias) is not None

    async def chat_profile(self, alias: str) -> dict | None:
        """The catalog row for a chat alias, or ``None`` if unknown.

        Returns the row rather than a bool so callers that need the
        download size do not have to re-list. ``size_bytes`` is
        ``None`` for repos missing from the size manifest — that is a
        real case (``google/embeddinggemma-300m-6bit``), and callers
        must treat it as "unknown", never as zero.
        """
        async with self._lock:
            available = await self._available_payload()
        for row in available.get("text", []):
            if row.get("alias") == alias:
                return row
        return None
