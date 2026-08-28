# SPDX-License-Identifier: Apache-2.0
"""HTTP surface served to the phone.

Route policy, since it is not uniform and the differences are
deliberate:

* ``GET /`` and the static assets are **unauthenticated**. They have to
  be: the page is what the user opens in order to enter the token.
  Nothing sensitive is in the HTML.
* Everything under ``/api`` and ``/v1`` requires the bearer, plus the
  browser-origin checks in :mod:`.auth`.
* ``GET /api/status`` is authenticated too, even though it is read-only.
  It reveals which model is loaded and the engine's recent log tail,
  which is more than an unauthenticated caller should learn about the
  host.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
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
    SupervisorError,
)

STATIC_DIR = Path(__file__).parent / "static"
ASSETS_DIR = STATIC_DIR / "assets"

_IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable"


class _HashedAssets(StaticFiles):
    """Serves the build's content-hashed assets as immutable."""

    def file_response(self, *args: object, **kwargs: object) -> Response:
        response = super().file_response(*args, **kwargs)  # type: ignore[arg-type]
        response.headers["Cache-Control"] = _IMMUTABLE_CACHE_CONTROL
        return response


class StreamTracker:
    """Counts chat streams currently being relayed.

    Model switching kills the engine process, so doing it while a
    generation is in flight destroys someone else's answer mid-sentence
    — most likely the person sitting at the Mac, who has no idea the
    phone exists. The count is what lets ``/api/models/load`` refuse
    with a 409 instead.

    A plain integer is enough: everything here runs on one event loop,
    and ``asyncio`` yields only at awaits, so increment and decrement are
    each atomic with respect to the other.
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
            # Must decrement even when the client vanishes mid-stream. A
            # leaked count would make switching impossible for the rest
            # of the session, with no way for the user to clear it.
            self._active -= 1


@dataclass
class WebConfig:
    """Everything the HTTP layer needs that is decided at startup."""

    # ``None`` disables the bearer entirely, which the CLI does only for
    # a loopback bind. It is deliberately not a boolean flag beside a
    # token: two fields could disagree, and the failure mode of that
    # disagreement is "auth silently off".
    token: str | None
    engine: EngineSupervisor | AttachedEngine
    # Model to load once the event loop is running. Loading cannot happen
    # before uvicorn starts: an asyncio subprocess is bound to the loop
    # that created it, so a child spawned under a throwaway
    # ``asyncio.run`` would be attached to a closed loop by the time the
    # first request arrives — its output drain would be dead and the pipe
    # would eventually fill and stall the engine.
    initial_model: str | None = None
    # ``None`` in --attach mode: listing aliases needs the CLI, and an
    # attached engine may be the only rapid-mlx on the machine.
    catalog: ModelCatalog | None = None
    # ``None`` when downloads are disabled — which is also the single
    # source of truth for whether they are allowed, so there is no
    # separate flag that could disagree with it.
    downloads: DownloadManager | None = None


def _json_error(status: int, message: str, code: str) -> JSONResponse:
    """Uniform error envelope.

    Matches the engine's ``{"error": {...}}`` shape so the page has a
    single error path for both proxied and locally-generated failures.
    """
    return JSONResponse(
        status_code=status,
        content={"error": {"message": message, "type": code}},
    )


async def _boot(config: WebConfig) -> None:
    """Load the initial model, recording failure in the supervisor.

    Failures are swallowed here rather than propagated: this runs as a
    detached task, and an unhandled exception in one only reaches the
    user as an asyncio warning on stderr. The supervisor has already
    recorded ``FAILED`` plus the child's output tail, which is what
    ``/api/status`` surfaces and what the page can actually show.
    """
    with contextlib.suppress(SupervisorError):
        await config.engine.start(config.initial_model)


async def _switch(config: WebConfig, alias: str) -> None:
    """Restart the engine on ``alias``.

    Failures are swallowed for the same reason as :func:`_boot`: this is
    a detached task, so raising would only produce an asyncio warning on
    the Mac's stderr, which the phone cannot see. The supervisor records
    ``FAILED`` plus the child's output, and ``/api/status`` surfaces it.
    """
    with contextlib.suppress(SupervisorError):
        await config.engine.start(alias)
    # The new model's weights may have just been pulled by the engine's
    # own downloader, so what is on disk has changed.
    if config.catalog is not None:
        config.catalog.invalidate_cache()


def create_app(config: WebConfig) -> FastAPI:
    streams = StreamTracker()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # One client for the whole process. Creating a client per request
        # throws away connection reuse and, more importantly, leaks
        # connections when a streaming response is abandoned partway.
        app.state.http = httpx.AsyncClient()

        # Kick the engine off in the background rather than awaiting it.
        # A cold start is minutes; blocking startup would leave the port
        # unbound for that whole time, so the phone would get "connection
        # refused" instead of a page saying "loading". The supervisor's
        # own state is what the page polls.
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
            # A pull left running past this process would keep writing to
            # the cache with nothing watching it, and the user has no way
            # to stop it short of hunting down the PID.
            if config.downloads is not None:
                with contextlib.suppress(Exception):
                    await config.downloads.shutdown()
            # Always stop the child, including when startup itself failed.
            # A half-started engine still holds GPU memory.
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

        # Static surface + the capability probe are open; see the module
        # docstring. ``/api/config`` has to be reachable without a token
        # because it is how the page learns whether a token is needed at
        # all. It reveals only that one bit — nothing about the host, the
        # loaded model, or the catalog.
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

        # The bearer is skipped only when the server is bound to
        # loopback, where the OS already guarantees the caller is a
        # process on this Mac. The Origin / content-type checks above
        # are NOT skipped with it: without a token they become the only
        # thing standing between this port and any web page the user
        # happens to have open, which can otherwise reach a loopback
        # port through the browser.
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

        Deliberately the only unauthenticated JSON endpoint, and it
        answers exactly one question. The page needs it before it can
        decide whether to show a login prompt; everything else stays
        behind the guard.
        """
        return JSONResponse({"auth_required": config.token is not None})

    @app.post("/api/auth")
    async def check_auth() -> JSONResponse:
        """Token probe for the login screen.

        Reaching this handler already means the middleware accepted the
        bearer, so the body is only a confirmation. It exists so the
        page can validate a pasted token without sending a chat turn.
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
        """Chat-capable aliases, with on-disk state.

        Only chat models are listed. Image, video and audio aliases have
        no chat surface, so including them would offer a multi-GB
        download for something that dead-ends on first send.
        """
        if config.catalog is None:
            return _json_error(
                501,
                "model listing is unavailable in --attach mode",
                "catalog_unavailable",
            )
        try:
            entries = await config.catalog.list_chat_models(force=refresh)
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

        # Validate against the catalog before the alias reaches a
        # subprocess argument. Passing an arbitrary string through would
        # let a remote caller name any `org/repo`, turning a model picker
        # into a general-purpose remote fetch.
        try:
            known = await config.catalog.is_known_chat_alias(alias)
        except CatalogError as exc:
            return _json_error(503, str(exc), "catalog_error")
        if not known:
            return _json_error(
                404, f"unknown chat model alias: {alias}", "unknown_model"
            )

        # Switching restarts the engine, which destroys any generation
        # in progress — including one belonging to whoever is sitting at
        # the Mac, who does not know this web surface exists.
        if streams.active:
            return _json_error(
                409,
                "a chat response is still streaming; try again once it finishes",
                "busy_streaming",
            )

        snapshot = engine.status()
        if snapshot.model == alias and snapshot.state is ChildState.READY:
            # Already there. Restarting would cost minutes of reload for
            # no change, and a double-tap on a phone is easy.
            return JSONResponse({"ok": True, "model": alias, "state": "ready"})

        if snapshot.state is ChildState.STARTING:
            return _json_error(
                409,
                f"{snapshot.model or 'a model'} is still loading; wait for it to finish",
                "busy_loading",
            )

        # Run the switch detached and answer immediately. A load takes
        # minutes, which is far past any phone browser's fetch timeout;
        # the page polls /api/status for the outcome, exactly as it does
        # for the initial boot.
        app.state.boot = asyncio.create_task(_switch(config, alias))
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

        # Same reasoning as the switch route: an unvalidated alias
        # reaching a subprocess argument is a remote fetch primitive.
        try:
            profile = await config.catalog.chat_profile(alias)
        except CatalogError as exc:
            return _json_error(503, str(exc), "catalog_error")
        if profile is None:
            return _json_error(
                404, f"unknown chat model alias: {alias}", "unknown_model"
            )

        # Fails closed when the size is unknown — see check_disk_budget.
        reason = check_disk_budget(profile.get("size_bytes"))
        if reason is not None:
            return _json_error(507, reason, "insufficient_storage")

        try:
            job = await config.downloads.start(
                alias, total_bytes=profile.get("size_bytes")
            )
        except DownloadError as exc:
            return _json_error(409, str(exc), "download_conflict")

        return JSONResponse({"ok": True, **job.to_dict()})

    # POST, not DELETE. The CSRF control in the middleware — reject any
    # body whose content-type is a CORS "simple" one — is applied to
    # POST/PUT/PATCH, because those are the methods a cross-origin page
    # can send without a preflight. A DELETE already requires a
    # preflight, so it is not weaker; but routing the one destructive
    # operation here through the method that carries the extra check
    # means there is no second policy to keep correct.
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

        # Refuse to delete what the engine is running. The weights are
        # mmap'd by the child, so unlinking them underneath it is not a
        # clean operation, and the recovery — stop the engine, delete,
        # leave the phone with nothing loaded — is a bigger decision
        # than a trash button should make on the user's behalf. They can
        # switch models first, which is one tap away in the same sheet.
        #
        # READY and STARTING only. A FAILED child has already exited and
        # holds nothing, and deleting a checkpoint that just failed to
        # load is precisely what a user does next.
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

        # A pull writing into the very snapshot being unlinked leaves a
        # half-materialised repo that the next scan reports as
        # "incomplete" — present enough to look downloaded to a stale
        # page, broken enough to fail inside the engine.
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

        Deliberately a poll rather than the SSE feed this replaced.
        Measured against a real ``trycloudflare`` tunnel: headers arrived
        in 1.8 s and then **not one body byte in 65 s**, while the same
        endpoint on loopback delivered its first frame in 0.0 s.
        Cloudflare also strips the ``X-Accel-Buffering: no`` hint (it is
        an nginx convention), and padding the first frame to 2 KiB did
        not shake the response loose either.

        The chat stream survives the same tunnel because it emits tokens
        continuously; a download feed that sends 25 bytes and then a
        keepalive every 15 s is too sparse to break through the buffer.

        Progress is low-frequency data — a bar that updates once a
        second is indistinguishable from one that updates ten times a
        second — so holding a long-lived connection open for it bought
        nothing and cost every intermediary's buffering behaviour.
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
            # /api/models/load can refuse rather than kill the engine
            # out from under this generation.
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
                    # Tunnels and reverse proxies buffer by default,
                    # which turns a token stream into one delivery at
                    # the end. nginx and several tunnel implementations
                    # honour this hint to disable that.
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
    """
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline'; "
        "style-src 'self' 'unsafe-inline'; "
        "connect-src 'self'; "
        "img-src 'self' data:; "
        "frame-ancestors 'none'; "
        "base-uri 'none'",
    )
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
