# SPDX-License-Identifier: Apache-2.0
"""HTTP surface served to the phone.

``GET /`` and the static assets are unauthenticated — the page is what the
user opens in order to enter the token. Everything under ``/api`` and
``/v1`` requires the bearer plus the browser-origin checks in :mod:`.auth`,
including read-only ``/api/status``, which reveals the loaded model and the
engine's log tail.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import contextlib
import hashlib
import json
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import auth, proxy
from .catalog import CatalogError, ModelCatalog, RemovalError
from .downloads import (
    DownloadError,
    DownloadManager,
    check_disk_budget,
)
from .supervisor import (
    AttachedEngine,
    ChildState,
    EngineSupervisor,
    ResidencyOutcome,
    SupervisorError,
)

STATIC_DIR = Path(__file__).parent / "static"
ASSETS_DIR = STATIC_DIR / "assets"

_IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable"

# Matches the engine's own ceiling (``MAX_AUDIO_UPLOAD_SIZE``), so an upload
# that would be refused there is refused here instead of after another hop.
MAX_AUDIO_BYTES = 25 * 1024 * 1024

# The engine's ``_MAX_EDIT_IMAGE_BYTES``, for the same reason.
MAX_IMAGE_BYTES = 25 * 1024 * 1024

# Filenames reaching a multipart part. Restricted rather than sanitised: the
# name is advisory (the engine spools every upload to a ``.wav`` temp file
# regardless), so there is nothing to gain by accepting a caller's arbitrary
# string in a header.
_UPLOAD_NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")

# What ``/api/residency`` answers when the engine is not reachable. A limit
# of 0 is the engine's own "no ceiling" spelling, which the page reads as
# "nothing to show" rather than "0 bytes used".
_EMPTY_RESIDENCY = {
    "memory_limit_bytes": 0,
    "memory_used_bytes": 0,
    "models": [],
}


def _upload_filename(candidate: object) -> str:
    if isinstance(candidate, str) and _UPLOAD_NAME_RE.match(candidate):
        return candidate
    return "recording.wav"


class _HashedAssets(StaticFiles):
    """Serves the build's content-hashed assets as immutable."""

    def file_response(self, *args: object, **kwargs: object) -> Response:
        response = super().file_response(*args, **kwargs)  # type: ignore[arg-type]
        response.headers["Cache-Control"] = _IMMUTABLE_CACHE_CONTROL
        return response


class StreamTracker:
    """Counts chat streams currently being relayed.

    Model switching kills the engine process, so ``/api/models/load`` uses
    this to refuse with a 409 rather than destroy an in-flight generation.
    A plain integer suffices: one event loop, and asyncio yields only at
    awaits.
    """

    def __init__(self) -> None:
        self._active = 0

    @property
    def active(self) -> int:
        return self._active

    @contextlib.contextmanager
    def track(self):
        self._active += 1
        try:
            yield
        finally:
            # Must decrement even when the client vanishes mid-stream, or
            # switching stays impossible for the rest of the session.
            self._active -= 1


@dataclass
class WebConfig:
    """Everything the HTTP layer needs that is decided at startup."""

    # ``None`` disables the bearer entirely, which is the default. Not a
    # boolean beside a token: two fields could disagree, and that failure
    # mode is "auth silently off".
    token: str | None
    engine: EngineSupervisor | AttachedEngine
    # Loaded once the event loop is running: an asyncio subprocess is bound
    # to the loop that created it, so spawning under a throwaway
    # ``asyncio.run`` leaves a dead output drain and eventually a full pipe.
    initial_model: str | None = None
    # ``None`` in --attach mode: listing aliases needs the CLI, and an
    # attached engine may be the only rapid-mlx on the machine.
    catalog: ModelCatalog | None = None
    # ``None`` when downloads are disabled — also the single source of
    # truth for whether they are allowed.
    downloads: DownloadManager | None = None


# Catalog kind -> the engine's own modality vocabulary. `audio` never
# reaches a resident load (its lane rides on the served model), so it is
# absent and the caller's `.get(..., "text")` default is never exercised
# for it.
_ENGINE_MODALITY = {"text": "text", "image": "image-gen"}


def _json_error(status: int, message: str, code: str) -> JSONResponse:
    """Uniform error envelope matching the engine's ``{"error": {...}}``."""
    return JSONResponse(
        status_code=status,
        content={"error": {"message": message, "type": code}},
    )


async def _boot(config: WebConfig) -> None:
    """Load the initial model, recording failure in the supervisor.

    Failures are swallowed because this is a detached task: raising only
    reaches the user as an asyncio warning on stderr, whereas the
    supervisor's ``FAILED`` state is what ``/api/status`` surfaces.
    """
    with contextlib.suppress(SupervisorError):
        await config.engine.start(config.initial_model)


async def _switch(config: WebConfig, alias: str, entry=None) -> None:
    """Make ``alias`` usable, hot if the engine allows it.

    A hot ``POST /v1/models/load`` is tried FIRST because it is the only
    way two models are usable at once: the engine keeps text/vision in one
    single-slot group and gives each media modality its own, so loading an
    image model beside a chat model leaves the chat model running. A
    respawn, by contrast, can only ever serve the one model it was started
    for.

    Every failure falls back to the respawn this package did
    unconditionally before, so the worst case is the old behaviour.
    Failures are swallowed as in :func:`_boot` — this is a detached task,
    and ``/api/status`` is what the page reads.
    """
    # Duck-typed rather than an isinstance check: the engine is the one seam
    # this package mocks, and `--attach` mode never reaches here (the route
    # refuses on `can_switch` first).
    hot = entry is not None and hasattr(config.engine, "residency_load")
    modality = _ENGINE_MODALITY.get(entry.kind, "text") if entry is not None else "text"
    if hot:
        outcome, _refusal = await config.engine.residency_load(
            alias,
            modality=modality,
            size_bytes=entry.size_bytes,
            image_mode="generation" if entry.kind == "image" else None,
        )
        if outcome is ResidencyOutcome.LOADED:
            if config.catalog is not None:
                config.catalog.invalidate_cache()
            return

    with contextlib.suppress(SupervisorError):
        await config.engine.start(alias, modality=modality)
    # The engine's own downloader may have just pulled these weights.
    if config.catalog is not None:
        config.catalog.invalidate_cache()


def create_app(config: WebConfig) -> FastAPI:
    streams = StreamTracker()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # One client per process: per-request clients lose connection reuse
        # and leak connections when a streaming response is abandoned.
        app.state.http = httpx.AsyncClient()

        # Background, not awaited: a cold start is minutes, and blocking
        # startup would leave the port unbound for all of it — the phone
        # would see "connection refused" instead of a page saying "loading".
        if config.initial_model and isinstance(config.engine, EngineSupervisor):
            app.state.boot = asyncio.create_task(_boot(config))
        else:
            app.state.boot = None

        try:
            yield
        finally:
            boot = app.state.boot
            if boot is not None and not boot.done():
                boot.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await boot
            with contextlib.suppress(Exception):
                await app.state.http.aclose()
            # A pull left running would keep writing to the cache with
            # nothing watching it, and no way to stop it short of the PID.
            if config.downloads is not None:
                with contextlib.suppress(Exception):
                    await config.downloads.shutdown()
            # Always stop the child, including when startup itself failed:
            # a half-started engine still holds GPU memory.
            await config.engine.stop()

    app = FastAPI(
        title="rmlx-web",
        docs_url=None,
        redoc_url=None,
        lifespan=lifespan,
    )
    app.state.config = config

    @app.middleware("http")
    async def _guard(request: Request, call_next):
        path = request.url.path

        # ``/api/config`` is open because it is how the page learns whether
        # a token is needed at all. It reveals only that one bit.
        if path == "/" or path == "/api/config" or path.startswith("/static"):
            response = await call_next(request)
            _apply_security_headers(response)
            return response

        if not auth.origin_is_allowed(
            request.headers.get("origin"),
            request.headers.get("host"),
            request.headers.get("sec-fetch-site"),
        ):
            return _json_error(403, "cross-origin request refused", "origin_refused")

        # Bodies must be JSON. This is a CSRF control rather than a
        # parsing convenience — see auth.content_type_is_json.
        if request.method in ("POST", "PUT", "PATCH") and not auth.content_type_is_json(
            request.headers.get("content-type")
        ):
            return _json_error(
                415,
                "requests must be sent as application/json",
                "unsupported_media_type",
            )

        # There is usually no bearer: it is opt-in via --token. The Origin
        # and content-type checks above are NOT tied to it, and without a
        # token they are the only thing between this port and any web page
        # the user happens to have open, since a browser can reach a
        # loopback port even when the network cannot.
        if config.token is not None:
            presented = auth.extract_bearer(request.headers.get("authorization"))
            if not auth.token_matches(config.token, presented):
                return _json_error(401, "missing or invalid token", "unauthorized")

        response = await call_next(request)
        _apply_security_headers(response)
        return response

    @app.get("/", response_class=HTMLResponse)
    async def index(request: Request) -> Response:
        raw = (STATIC_DIR / "index.html").read_bytes()
        etag = f'"{hashlib.sha256(raw).hexdigest()[:32]}"'

        # If-None-Match may carry a list, so match on membership.
        if etag in [
            candidate.strip()
            for candidate in (request.headers.get("if-none-match") or "").split(",")
            if candidate.strip()
        ]:
            return Response(status_code=304, headers={"ETag": etag})

        return HTMLResponse(
            raw.decode("utf-8"),
            headers={"ETag": etag, "Cache-Control": "no-cache"},
        )

    @app.get("/api/config")
    async def public_config() -> JSONResponse:
        """Unauthenticated: does this server require a token?

        The only unauthenticated JSON endpoint. The page needs the answer
        before it can decide whether to show a login prompt.
        """
        return JSONResponse({"auth_required": config.token is not None})

    @app.post("/api/auth")
    async def check_auth() -> JSONResponse:
        """Token probe for the login screen.

        Reaching this handler already means the middleware accepted the
        bearer; it exists so the page can validate a pasted token without
        sending a chat turn.
        """
        engine = config.engine
        return JSONResponse(
            {
                "ok": True,
                "can_switch": engine.can_switch,
                "allow_downloads": config.downloads is not None,
            }
        )

    @app.get("/api/status")
    async def status() -> JSONResponse:
        engine = config.engine
        snapshot = engine.status()
        body = snapshot.to_dict()
        body["can_switch"] = engine.can_switch
        # The log tail is only useful when something went wrong, and it
        # can contain file paths; withhold it otherwise.
        if snapshot.state is ChildState.FAILED:
            body["recent_output"] = snapshot.recent_output[-20:]
        return JSONResponse(body)

    @app.get("/api/models")
    async def list_models(refresh: bool = False) -> JSONResponse:
        """Every alias, tagged with its kind.

        Image and audio rows are included so the model manager can show
        them, and each carries ``loadable`` — audio has no ``serve`` lane
        here, so the picker must not offer to start one.
        """
        if config.catalog is None:
            return _json_error(
                501,
                "model listing is unavailable in --attach mode",
                "catalog_unavailable",
            )
        try:
            entries = await config.catalog.list_models(force=refresh)
        except CatalogError as exc:
            return _json_error(503, str(exc), "catalog_error")

        snapshot = config.engine.status()
        return JSONResponse(
            {
                "models": [entry.to_dict() for entry in entries],
                "loaded": snapshot.model,
                "state": snapshot.state.value,
                "can_switch": config.engine.can_switch,
                "allow_downloads": config.downloads is not None,
            }
        )

    @app.post("/api/models/load")
    async def load_model(request: Request):
        engine = config.engine
        if not engine.can_switch or config.catalog is None:
            return _json_error(
                409,
                "this server does not own the engine, so it cannot switch models",
                "switch_unavailable",
            )

        try:
            payload = await request.json()
        except (ValueError, json.JSONDecodeError):
            return _json_error(400, "request body was not valid JSON", "invalid_json")

        alias = payload.get("model") if isinstance(payload, dict) else None
        if not isinstance(alias, str) or not alias.strip():
            return _json_error(
                400, "`model` must be a non-empty string", "invalid_body"
            )
        alias = alias.strip()

        # Validate against the catalog before the alias reaches a subprocess
        # argument: an arbitrary string would let a remote caller name any
        # `org/repo`, turning a model picker into a general-purpose fetch.
        try:
            entry = await config.catalog.profile(alias)
        except CatalogError as exc:
            return _json_error(503, str(exc), "catalog_error")
        if entry is None:
            return _json_error(404, f"unknown model alias: {alias}", "unknown_model")
        if not entry.loadable:
            # Only `video` today: its lane needs extras a plain install
            # does not ship, which is also why the catalog omits it.
            return _json_error(
                409,
                f"{alias} cannot be loaded as the served model.",
                "kind_not_loadable",
            )

        # Switching restarts the engine, destroying any generation in
        # progress — including one belonging to whoever is at the Mac.
        if streams.active:
            return _json_error(
                409,
                "a chat response is still streaming; try again once it finishes",
                "busy_streaming",
            )

        snapshot = engine.status()
        if snapshot.model == alias and snapshot.state is ChildState.READY:
            # Already there; a double-tap on a phone is easy and a restart
            # would cost minutes of reload for no change.
            return JSONResponse({"ok": True, "model": alias, "state": "ready"})

        if snapshot.state is ChildState.STARTING:
            return _json_error(
                409,
                f"{snapshot.model or 'a model'} is still loading; wait for it to finish",
                "busy_loading",
            )

        # Already resident from an earlier hot load — the engine routes by
        # the request's `model` field, so there is nothing to do.
        if alias in snapshot.resident and snapshot.state is ChildState.READY:
            return JSONResponse({"ok": True, "model": alias, "state": "ready"})

        # Detached, answering immediately: a load takes minutes, far past
        # any phone browser's fetch timeout. The page polls /api/status.
        app.state.boot = asyncio.create_task(_switch(config, alias, entry))
        return JSONResponse({"ok": True, "model": alias, "state": "starting"})

    @app.post("/api/models/pull")
    async def pull_model(request: Request):
        if config.downloads is None or config.catalog is None:
            return _json_error(
                403,
                "downloads are disabled on this server "
                "(start it with --allow-downloads)",
                "downloads_disabled",
            )

        try:
            payload = await request.json()
        except (ValueError, json.JSONDecodeError):
            return _json_error(400, "request body was not valid JSON", "invalid_json")

        alias = payload.get("model") if isinstance(payload, dict) else None
        if not isinstance(alias, str) or not alias.strip():
            return _json_error(
                400, "`model` must be a non-empty string", "invalid_body"
            )
        alias = alias.strip()

        # Same reasoning as the switch route: an unvalidated alias reaching
        # a subprocess argument is a remote fetch primitive.
        try:
            entry = await config.catalog.profile(alias)
        except CatalogError as exc:
            return _json_error(503, str(exc), "catalog_error")
        if entry is None:
            return _json_error(404, f"unknown model alias: {alias}", "unknown_model")

        # Fails closed when the size is unknown — see check_disk_budget.
        reason = check_disk_budget(entry.size_bytes)
        if reason is not None:
            return _json_error(507, reason, "insufficient_storage")

        try:
            job = await config.downloads.start(alias, total_bytes=entry.size_bytes)
        except DownloadError as exc:
            return _json_error(409, str(exc), "download_conflict")

        return JSONResponse({"ok": True, **job.to_dict()})

    # POST, not DELETE: the middleware's CSRF control (reject CORS-simple
    # content types) runs on POST/PUT/PATCH, so routing the one destructive
    # operation through it avoids a second policy to keep correct.
    @app.post("/api/models/remove")
    async def remove_model(request: Request):
        if config.catalog is None:
            return _json_error(
                501,
                "model removal is unavailable in --attach mode",
                "catalog_unavailable",
            )

        try:
            payload = await request.json()
        except (ValueError, json.JSONDecodeError):
            return _json_error(400, "request body was not valid JSON", "invalid_json")

        alias = payload.get("model") if isinstance(payload, dict) else None
        if not isinstance(alias, str) or not alias.strip():
            return _json_error(
                400, "`model` must be a non-empty string", "invalid_body"
            )
        alias = alias.strip()

        # Refuse to delete what the engine is running: the weights are
        # mmap'd by the child. READY and STARTING only — a FAILED child has
        # exited and holds nothing, and deleting a checkpoint that just
        # failed to load is precisely what a user does next.
        snapshot = config.engine.status()
        if snapshot.model == alias and snapshot.state in (
            ChildState.READY,
            ChildState.STARTING,
        ):
            return _json_error(
                409,
                f"{alias} is the model this server is running. "
                "Switch to another model first, then delete it.",
                "model_in_use",
            )

        # A pull writing into the snapshot being unlinked leaves a
        # half-materialised repo: present enough to look downloaded to a
        # stale page, broken enough to fail inside the engine.
        running = config.downloads.job if config.downloads is not None else None
        if (
            running is not None
            and running.alias == alias
            and config.downloads.is_running()
        ):
            return _json_error(
                409,
                f"{alias} is still downloading. Cancel the download first.",
                "model_in_use",
            )

        try:
            freed = await config.catalog.remove(alias)
        except CatalogError as exc:
            return _json_error(503, str(exc), "catalog_error")
        except RemovalError as exc:
            return _json_error(409, str(exc), "removal_failed")

        return JSONResponse({"ok": True, "model": alias, "freed_bytes": freed})

    @app.post("/api/downloads/cancel")
    async def cancel_download():
        if config.downloads is None:
            return _json_error(
                403, "downloads are disabled on this server", "downloads_disabled"
            )
        cancelled = await config.downloads.cancel()
        if not cancelled:
            return _json_error(409, "no download is running", "no_download")
        return JSONResponse({"ok": True})

    @app.get("/api/downloads/status")
    async def download_status():
        """Current download job, polled by the page.

        A poll rather than the SSE feed this replaced: measured against a
        real ``trycloudflare`` tunnel, a sparse feed delivered headers in
        1.8 s and then no body byte in 65 s (loopback: 0.0 s). Cloudflare
        strips ``X-Accel-Buffering`` and padding the first frame did not
        help. Chat streaming survives the same tunnel because it emits
        tokens continuously — sparseness is the variable, not SSE.
        """
        if config.downloads is None:
            return _json_error(
                403, "downloads are disabled on this server", "downloads_disabled"
            )
        job = config.downloads.job
        return JSONResponse(job.to_dict() if job is not None else {"state": "idle"})

    @app.post("/v1/chat/completions")
    async def chat_completions(request: Request):
        try:
            payload = await request.json()
        except (ValueError, json.JSONDecodeError):
            return _json_error(400, "request body was not valid JSON", "invalid_json")

        if not isinstance(payload, dict):
            return _json_error(
                400, "request body must be a JSON object", "invalid_json"
            )

        engine = config.engine
        base_url = engine.base_url
        if base_url is None:
            snapshot = engine.status()
            # 503 rather than 502: the engine is not broken, it is not
            # there yet. The page retries on 503 and gives up on 502.
            return _json_error(
                503,
                _unavailable_message(snapshot.state, snapshot.detail),
                "engine_unavailable",
            )

        if proxy.is_streaming_request(payload):
            # Counted for the whole life of the relay, so a concurrent
            # /api/models/load refuses rather than killing the engine.
            async def tracked() -> AsyncIterator[bytes]:
                with streams.track():
                    async for chunk in proxy.proxy_streaming(
                        app.state.http,
                        base_url=base_url,
                        path="/v1/chat/completions",
                        payload=payload,
                        api_key=engine.api_key,
                    ):
                        yield chunk

            return StreamingResponse(
                tracked(),
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    # nginx and several tunnels honour this to disable the
                    # buffering that would deliver the stream all at once.
                    "X-Accel-Buffering": "no",
                },
            )

        with streams.track():
            try:
                upstream = await proxy.proxy_unary(
                    app.state.http,
                    base_url=base_url,
                    path="/v1/chat/completions",
                    payload=payload,
                    api_key=engine.api_key,
                )
            except httpx.HTTPError as exc:
                return _json_error(
                    502, f"connection to the engine failed: {exc}", "engine_transport"
                )

        return JSONResponse(
            status_code=upstream.status_code,
            content=_decode_json_body(upstream),
            headers=proxy.filtered_response_headers(upstream.headers),
        )

    @app.post("/v1/images/generations")
    async def image_generations(request: Request):
        """Render an image on the loaded image model.

        A plain relay, with one addition: the request is counted as a
        stream so a concurrent ``/api/models/load`` refuses rather than
        killing the engine mid-render. A render is minutes of GPU work
        and has no resume.
        """
        try:
            payload = await request.json()
        except (ValueError, json.JSONDecodeError):
            return _json_error(400, "request body was not valid JSON", "invalid_json")
        if not isinstance(payload, dict):
            return _json_error(
                400, "request body must be a JSON object", "invalid_json"
            )

        engine = config.engine
        base_url = engine.base_url
        if base_url is None:
            snapshot = engine.status()
            return _json_error(
                503,
                _unavailable_message(snapshot.state, snapshot.detail),
                "engine_unavailable",
            )

        with streams.track():
            try:
                upstream = await proxy.proxy_unary(
                    app.state.http,
                    base_url=base_url,
                    path="/v1/images/generations",
                    payload=payload,
                    api_key=engine.api_key,
                )
            except httpx.HTTPError as exc:
                return _json_error(
                    502, f"connection to the engine failed: {exc}", "engine_transport"
                )

        return JSONResponse(
            status_code=upstream.status_code,
            content=_decode_json_body(upstream),
            headers=proxy.filtered_response_headers(upstream.headers),
        )

    @app.post("/api/images/edits")
    async def image_edits(request: Request):
        """Instruction-edit an image the user supplied.

        JSON with the source as base64, rebuilt into the multipart the
        engine's ``/v1/images/edits`` expects — the middleware's CSRF
        control rejects ``multipart/form-data``, so relaying the browser's
        own would need a second, weaker policy. Same reasoning as
        ``/api/audio/transcriptions``.

        ``size`` is deliberately not forwarded: the edit backends derive
        their canvas from the input image and the engine discards it.
        """
        try:
            payload = await request.json()
        except (ValueError, json.JSONDecodeError):
            return _json_error(400, "request body was not valid JSON", "invalid_json")
        if not isinstance(payload, dict):
            return _json_error(
                400, "request body must be a JSON object", "invalid_json"
            )

        prompt = payload.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip():
            return _json_error(400, "`prompt` must not be empty", "invalid_body")

        encoded = payload.get("image")
        if not isinstance(encoded, str) or not encoded:
            return _json_error(
                400, "`image` must be a base64-encoded string", "invalid_body"
            )
        try:
            content = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            return _json_error(400, "`image` was not valid base64", "invalid_body")
        if not content:
            return _json_error(400, "the image was empty", "invalid_body")
        if len(content) > MAX_IMAGE_BYTES:
            return _json_error(
                413,
                f"that image is larger than {MAX_IMAGE_BYTES // (1024 * 1024)} MB",
                "payload_too_large",
            )

        engine = config.engine
        base_url = engine.base_url
        if base_url is None:
            snapshot = engine.status()
            return _json_error(
                503,
                _unavailable_message(snapshot.state, snapshot.detail),
                "engine_unavailable",
            )

        fields = {"prompt": prompt, "n": "1", "response_format": "b64_json"}
        model = payload.get("model")
        if isinstance(model, str) and model:
            fields["model"] = model

        # Counted like a render: an edit is minutes of GPU work with no
        # resume, and a concurrent switch would kill the engine doing it.
        with streams.track():
            try:
                upstream = await proxy.proxy_multipart(
                    app.state.http,
                    base_url=base_url,
                    path="/v1/images/edits",
                    api_key=engine.api_key,
                    field="image",
                    # The engine sniffs the real format from the bytes; the
                    # name and type here only have to be well-formed.
                    filename="input.png",
                    content_type="image/png",
                    content=content,
                    fields=fields,
                )
            except httpx.HTTPError as exc:
                return _json_error(
                    502, f"connection to the engine failed: {exc}", "engine_transport"
                )

        return JSONResponse(
            status_code=upstream.status_code, content=_decode_json_body(upstream)
        )

    @app.get("/api/images/progress")
    async def image_progress(model: str = ""):
        """Denoise progress for the single in-flight render.

        Polled, like the download feed and for the same reason: a sparse
        SSE body is buffered indefinitely by a tunnel. Diffusion has a
        fixed step count, so ``step / total`` is a true fraction rather
        than an estimate.

        An unreachable engine answers ``running: false`` rather than an
        error — the poller's job is to report the render, and a dropped
        poll mid-render is not itself a failure.
        """
        engine = config.engine
        base_url = engine.base_url
        if base_url is None:
            return JSONResponse({"running": False, "step": 0, "total": 0})
        try:
            upstream = await proxy.proxy_get(
                app.state.http,
                base_url=base_url,
                path="/v1/images/progress",
                api_key=engine.api_key,
                params={"model": model} if model else None,
            )
        except httpx.HTTPError:
            return JSONResponse({"running": False, "step": 0, "total": 0})
        if upstream.status_code >= 400:
            return JSONResponse({"running": False, "step": 0, "total": 0})
        return JSONResponse(_decode_json_body(upstream))

    @app.post("/api/images/cancel")
    async def image_cancel(request: Request):
        engine = config.engine
        base_url = engine.base_url
        if base_url is None:
            return _json_error(503, "no model is loaded", "engine_unavailable")

        try:
            payload = await request.json()
        except (ValueError, json.JSONDecodeError):
            payload = {}
        model = payload.get("model") if isinstance(payload, dict) else None

        try:
            upstream = await proxy.proxy_post_query(
                app.state.http,
                base_url=base_url,
                path="/v1/images/cancel",
                api_key=engine.api_key,
                params={"model": model} if isinstance(model, str) and model else None,
            )
        except httpx.HTTPError as exc:
            return _json_error(
                502, f"connection to the engine failed: {exc}", "engine_transport"
            )
        return JSONResponse(
            status_code=upstream.status_code, content=_decode_json_body(upstream)
        )

    @app.get("/api/residency")
    async def residency():
        """Resident models and process memory against the engine's ceiling.

        Polled while the page is open, so an unreachable engine answers an
        EMPTY snapshot rather than an error: the panel's job is to describe
        the machine, and a dropped poll during a model switch is not a
        failure worth putting a banner over.
        """
        engine = config.engine
        base_url = engine.base_url
        if base_url is None:
            return JSONResponse(_EMPTY_RESIDENCY)
        try:
            upstream = await proxy.proxy_get(
                app.state.http,
                base_url=base_url,
                path="/v1/models/residency",
                api_key=engine.api_key,
            )
        except httpx.HTTPError:
            return JSONResponse(_EMPTY_RESIDENCY)
        if upstream.status_code >= 400:
            return JSONResponse(_EMPTY_RESIDENCY)
        return JSONResponse(_decode_json_body(upstream))

    # ---------------------------------------------------------------- audio
    #
    # The audio lane rides on WHATEVER model the engine is serving: the
    # child is spawned with ``--enable-audio``, and the engine's gate
    # short-circuits on that flag before it looks at the model. So speech
    # works while a chat model is loaded, and no model switch is needed.

    @app.get("/api/audio/voices")
    async def audio_voices(model: str = ""):
        engine = config.engine
        base_url = engine.base_url
        if base_url is None:
            snapshot = engine.status()
            return _json_error(
                503,
                _unavailable_message(snapshot.state, snapshot.detail),
                "engine_unavailable",
            )
        try:
            upstream = await proxy.proxy_get(
                app.state.http,
                base_url=base_url,
                path="/v1/audio/voices",
                api_key=engine.api_key,
                params={"model": model} if model else None,
                # The first call loads the TTS registry, not the weights,
                # but a cold import is still slower than a status poll.
                timeout=60.0,
            )
        except httpx.HTTPError as exc:
            return _json_error(
                502, f"connection to the engine failed: {exc}", "engine_transport"
            )
        return JSONResponse(
            status_code=upstream.status_code, content=_decode_json_body(upstream)
        )

    @app.post("/api/audio/speech")
    async def audio_speech(request: Request):
        """Synthesise speech, answering with the audio bytes.

        Counted as a stream: a cold Kokoro request measured 47 s, and a
        model switch mid-synthesis would kill the engine doing it.
        """
        try:
            payload = await request.json()
        except (ValueError, json.JSONDecodeError):
            return _json_error(400, "request body was not valid JSON", "invalid_json")
        if not isinstance(payload, dict):
            return _json_error(
                400, "request body must be a JSON object", "invalid_json"
            )

        engine = config.engine
        base_url = engine.base_url
        if base_url is None:
            snapshot = engine.status()
            return _json_error(
                503,
                _unavailable_message(snapshot.state, snapshot.detail),
                "engine_unavailable",
            )

        with streams.track():
            try:
                upstream = await proxy.proxy_audio_json(
                    app.state.http,
                    base_url=base_url,
                    path="/v1/audio/speech",
                    payload=payload,
                    api_key=engine.api_key,
                )
            except httpx.HTTPError as exc:
                return _json_error(
                    502, f"connection to the engine failed: {exc}", "engine_transport"
                )

        # A failure is JSON; a success is audio. Branch on the status, not
        # on the content type, so an engine that mislabels still surfaces
        # its error rather than handing the page unplayable bytes.
        if upstream.status_code >= 400:
            return JSONResponse(
                status_code=upstream.status_code, content=_decode_json_body(upstream)
            )
        return Response(
            content=upstream.content,
            media_type=upstream.headers.get("content-type", "audio/wav"),
            headers=proxy.filtered_response_headers(upstream.headers),
        )

    @app.post("/api/audio/transcriptions")
    async def audio_transcriptions(request: Request):
        """Transcribe an upload sent as base64 inside a JSON body.

        JSON rather than a relayed multipart because the middleware's CSRF
        control rejects the CORS-simple content types, and
        ``multipart/form-data`` is one of them. Re-encoding here keeps one
        policy instead of carving an exception for a single route.
        """
        try:
            payload = await request.json()
        except (ValueError, json.JSONDecodeError):
            return _json_error(400, "request body was not valid JSON", "invalid_json")
        if not isinstance(payload, dict):
            return _json_error(
                400, "request body must be a JSON object", "invalid_json"
            )

        encoded = payload.get("audio")
        if not isinstance(encoded, str) or not encoded:
            return _json_error(
                400, "`audio` must be a base64-encoded string", "invalid_body"
            )
        try:
            content = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            return _json_error(400, "`audio` was not valid base64", "invalid_body")
        if not content:
            return _json_error(400, "the recording was empty", "invalid_body")
        # Checked before the relay so an oversize upload is refused here
        # rather than after being pushed across another hop.
        if len(content) > MAX_AUDIO_BYTES:
            return _json_error(
                413,
                f"that recording is larger than {MAX_AUDIO_BYTES // (1024 * 1024)} MB",
                "payload_too_large",
            )

        engine = config.engine
        base_url = engine.base_url
        if base_url is None:
            snapshot = engine.status()
            return _json_error(
                503,
                _unavailable_message(snapshot.state, snapshot.detail),
                "engine_unavailable",
            )

        fields = {"response_format": "json"}
        for key in ("model", "language", "context"):
            value = payload.get(key)
            if isinstance(value, str) and value:
                fields[key] = value

        with streams.track():
            try:
                upstream = await proxy.proxy_multipart(
                    app.state.http,
                    base_url=base_url,
                    path="/v1/audio/transcriptions",
                    api_key=engine.api_key,
                    # Advisory: the engine spools to a ``.wav`` temp file and
                    # decodes the CONTAINER, so a name cannot make an
                    # undecodable upload readable. The page transcodes to WAV
                    # before sending — libsndfile reads neither mp4 nor webm.
                    filename=_upload_filename(payload.get("filename")),
                    content=content,
                    fields=fields,
                )
            except httpx.HTTPError as exc:
                return _json_error(
                    502, f"connection to the engine failed: {exc}", "engine_transport"
                )

        return JSONResponse(
            status_code=upstream.status_code, content=_decode_json_body(upstream)
        )

    # After the API routes: a mount matches on prefix and swallows
    # everything beneath it. check_dir=False so a checkout that never ran the
    # frontend build still starts.
    app.mount(
        "/static/assets",
        _HashedAssets(directory=ASSETS_DIR, check_dir=False),
        name="assets",
    )

    return app


def _decode_json_body(response: httpx.Response) -> dict:
    try:
        return response.json()
    except ValueError:
        return {
            "error": {
                "message": response.text[:400],
                "type": "engine_malformed_response",
            }
        }


def _unavailable_message(state: ChildState, detail: str | None) -> str:
    if state is ChildState.STARTING:
        return "the model is still loading; retry shortly"
    if state is ChildState.FAILED:
        return f"the engine failed to start: {detail or 'unknown error'}"
    return "no model is loaded"


def _apply_security_headers(response) -> None:
    """Headers applied to every response.

    ``'unsafe-inline'`` stays on style-src: Radix's scroll lock injects a
    ``<style>`` tag at runtime and is silently ignored without it.

    ``media-src`` must name ``blob:`` explicitly. Synthesised speech is
    handed to ``<audio>`` as an object URL, and without its own directive
    ``media-src`` falls back to ``default-src 'self'`` — which does not
    cover ``blob:``. The element then fails with ``MediaError`` code 4 and
    a player stuck at ``0:00 / 0:00``, while the identical URL still
    downloads fine (a download is not governed by a fetch directive), so
    the bytes look correct and the fault appears to be in the audio.
    """
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline'; "
        "style-src 'self' 'unsafe-inline'; "
        "connect-src 'self'; "
        "img-src 'self' data:; "
        "media-src 'self' blob:; "
        "frame-ancestors 'none'; "
        "base-uri 'none'",
    )
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
