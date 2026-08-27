# SPDX-License-Identifier: Apache-2.0
"""Tests for the HTTP surface.

The engine is replaced by a fake so these run without MLX, a model, or a
`rapid-mlx` install. That is the point of driving the CLI as a
subprocess rather than importing ``vllm_mlx``: the seam is mockable.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import re
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from rmlx_web import app as app_module
from rmlx_web.app import WebConfig, create_app
from rmlx_web.catalog import CatalogError, ModelEntry
from rmlx_web.downloads import DownloadError, DownloadJob, DownloadState
from rmlx_web.supervisor import ChildState, ChildStatus


async def _never_disconnected():
    return False


TOKEN = "test-token-value"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
JSON_CT = {"Content-Type": "application/json"}


class FakeEngine:
    """Stands in for EngineSupervisor / AttachedEngine."""

    def __init__(self, *, state=ChildState.READY, model="fake-model", can_switch=True):
        self._state = state
        self._model = model
        self.can_switch = can_switch
        self.api_key = "engine-side-key"
        self.stopped = False
        self.started = []

    @property
    def base_url(self):
        return "http://engine.invalid" if self._state is ChildState.READY else None

    def status(self):
        return ChildStatus(
            state=self._state,
            model=self._model,
            port=1234,
            detail="boom" if self._state is ChildState.FAILED else None,
            recent_output=["line one", "line two"],
        )

    async def start(self, model):
        self.started.append(model)
        self._model = model

    async def stop(self):
        self.stopped = True


class FakeCatalog:
    """Stands in for ModelCatalog, with no subprocess."""

    def __init__(self, entries=None, error=None):
        self.entries = (
            entries
            if entries is not None
            else [
                ModelEntry(
                    alias="qwen3.5-9b-4bit",
                    hf_path="mlx-community/Qwen3.5-9B-4bit",
                    size_bytes=5977075377,
                    cached=True,
                    cached_bytes=5977075377,
                ),
                ModelEntry(
                    alias="bonsai-1.7b-2bit",
                    hf_path="prism-ml/Ternary-Bonsai-1.7B-mlx-2bit",
                    size_bytes=495525300,
                    cached=False,
                ),
            ]
        )
        self.error = error
        self.forced = []
        self.invalidated = 0

    async def list_chat_models(self, *, force=False):
        if self.error:
            raise self.error
        self.forced.append(force)
        return self.entries

    async def is_known_chat_alias(self, alias):
        return await self.chat_profile(alias) is not None

    async def chat_profile(self, alias):
        if self.error:
            raise self.error
        for entry in self.entries:
            if entry.alias == alias:
                return {
                    "alias": alias,
                    "hf_path": entry.hf_path,
                    "size_bytes": entry.size_bytes,
                }
        return None

    def invalidate_cache(self):
        self.invalidated += 1


def build_client(
    engine=None, catalog="default", downloads=None, token=TOKEN, **config_kwargs
):
    if catalog == "default":
        catalog = FakeCatalog()
    config = WebConfig(
        token=token,
        engine=engine or FakeEngine(),
        catalog=catalog,
        downloads=downloads,
        **config_kwargs,
    )
    return TestClient(create_app(config))


class TestAuthGate:
    def test_index_is_reachable_without_a_token(self):
        # The page is where the user enters the token, so it cannot
        # itself require one.
        with build_client() as client:
            response = client.get("/")
        assert response.status_code == 200
        assert "Rapid-MLX" in response.text

    def test_api_requires_a_token(self):
        with build_client() as client:
            response = client.get("/api/status")
        assert response.status_code == 401
        assert response.json()["error"]["type"] == "unauthorized"

    def test_api_rejects_a_wrong_token(self):
        with build_client() as client:
            response = client.get(
                "/api/status", headers={"Authorization": "Bearer nope"}
            )
        assert response.status_code == 401

    def test_api_accepts_the_right_token(self):
        with build_client() as client:
            response = client.get("/api/status", headers=AUTH)
        assert response.status_code == 200

    def test_cross_site_request_is_refused_before_the_token_is_checked(self):
        with build_client() as client:
            response = client.get(
                "/api/status",
                headers={
                    **AUTH,
                    "Origin": "https://evil.example",
                    "Sec-Fetch-Site": "cross-site",
                },
            )
        # 403, not 401: the token was valid. A page the user has open
        # could have been given it, so the origin check must still bite.
        assert response.status_code == 403
        assert response.json()["error"]["type"] == "origin_refused"

    def test_post_with_a_simple_content_type_is_refused(self):
        with build_client() as client:
            response = client.post(
                "/api/auth",
                headers={**AUTH, "Content-Type": "text/plain"},
                content="{}",
            )
        # text/plain is a CORS "simple" type and would reach us with no
        # preflight from a cross-origin page.
        assert response.status_code == 415
        assert response.json()["error"]["type"] == "unsupported_media_type"


class TestSecurityHeaders:
    def test_index_carries_a_restrictive_csp(self):
        with build_client() as client:
            response = client.get("/")
        csp = response.headers["Content-Security-Policy"]
        assert "default-src 'self'" in csp
        assert "frame-ancestors 'none'" in csp
        assert response.headers["X-Content-Type-Options"] == "nosniff"


class TestIndexIsSelfContained:
    """Every asset the page references must actually be served.

    ``static/`` is a build output (``apps/rapid-web/frontend/``, ``npm run
    build``) that is committed. The shell references hashed files under
    ``/static/assets/``; if one is missing the page renders blank. This runs
    in the Python suite, so a stale artifact is caught even by someone who
    never touches Node.
    """

    _URL_ATTRIBUTES = re.compile(r'\b(?:src|href)\s*=\s*"([^"]*)"', re.IGNORECASE)

    def _served_html(self) -> str:
        with build_client() as client:
            response = client.get("/")
        assert response.status_code == 200
        return response.text

    def _referenced(self) -> list[str]:
        return [
            url
            for url in self._URL_ATTRIBUTES.findall(self._served_html())
            if not url.startswith("data:")
        ]

    def test_the_page_references_its_assets(self):
        referenced = self._referenced()
        assert referenced, "the built page references no assets at all"
        assert all(url.startswith("/static/") for url in referenced), (
            f"expected every asset under /static/, got {referenced}"
        )

    def test_every_referenced_asset_is_served(self):
        with build_client() as client:
            for url in self._referenced():
                response = client.get(url)
                assert response.status_code == 200, f"{url} -> {response.status_code}"

    def test_assets_are_cached_immutably(self):
        with build_client() as client:
            for url in self._referenced():
                cache_control = client.get(url).headers.get("cache-control", "")
                assert "immutable" in cache_control, f"{url}: {cache_control!r}"

    def test_the_shell_revalidates_rather_than_caching(self):
        with build_client() as client:
            response = client.get("/")
        assert response.headers["Cache-Control"] == "no-cache"
        assert response.headers["ETag"]

    def test_a_matching_etag_gets_a_304(self):
        with build_client() as client:
            etag = client.get("/").headers["ETag"]
            repeat = client.get("/", headers={"If-None-Match": etag})
        assert repeat.status_code == 304
        assert not repeat.content

    def test_the_title_is_contiguous(self):
        # ``test_index_is_reachable_without_a_token`` asserts "Rapid-MLX"
        # appears in the body. The rendered wordmark is
        # ``Rapid<span>-MLX</span>``, which is NOT contiguous, so <title> is the
        # only thing satisfying it. Pinned separately so that dependency is
        # visible rather than incidental.
        assert "<title>Rapid-MLX</title>" in self._served_html()


class TestStatus:
    def test_reports_the_loaded_model(self):
        with build_client() as client:
            body = client.get("/api/status", headers=AUTH).json()
        assert body["state"] == "ready"
        assert body["model"] == "fake-model"
        assert body["can_switch"] is True

    def test_log_tail_is_withheld_unless_the_engine_failed(self):
        with build_client() as client:
            body = client.get("/api/status", headers=AUTH).json()
        # The tail can carry filesystem paths; it is only worth the
        # exposure when it explains a failure.
        assert "recent_output" not in body

    def test_log_tail_is_included_on_failure(self):
        engine = FakeEngine(state=ChildState.FAILED)
        with build_client(engine) as client:
            body = client.get("/api/status", headers=AUTH).json()
        assert body["state"] == "failed"
        assert body["recent_output"] == ["line one", "line two"]

    def test_attach_mode_reports_that_switching_is_unavailable(self):
        engine = FakeEngine(can_switch=False)
        with build_client(engine) as client:
            body = client.get("/api/status", headers=AUTH).json()
        assert body["can_switch"] is False


class TestChatCompletions:
    def test_returns_503_while_the_engine_is_still_loading(self):
        engine = FakeEngine(state=ChildState.STARTING)
        with build_client(engine) as client:
            response = client.post(
                "/v1/chat/completions",
                headers={**AUTH, **JSON_CT},
                json={"messages": [{"role": "user", "content": "hi"}]},
            )
        # 503, not 502: nothing is broken, it is not there yet. The page
        # retries on 503.
        assert response.status_code == 503
        assert response.json()["error"]["type"] == "engine_unavailable"
        assert "loading" in response.json()["error"]["message"]

    def test_failure_detail_is_surfaced(self):
        engine = FakeEngine(state=ChildState.FAILED)
        with build_client(engine) as client:
            response = client.post(
                "/v1/chat/completions",
                headers={**AUTH, **JSON_CT},
                json={"messages": []},
            )
        assert response.status_code == 503
        assert "boom" in response.json()["error"]["message"]

    def test_malformed_json_body_is_rejected(self):
        with build_client() as client:
            response = client.post(
                "/v1/chat/completions",
                headers={**AUTH, **JSON_CT},
                content="not json",
            )
        assert response.status_code == 400
        assert response.json()["error"]["type"] == "invalid_json"

    def test_non_object_json_body_is_rejected(self):
        with build_client() as client:
            response = client.post(
                "/v1/chat/completions",
                headers={**AUTH, **JSON_CT},
                content="[1, 2, 3]",
            )
        assert response.status_code == 400


class TestProxyForwarding:
    """The proxy must swap credentials, not forward them."""

    def test_unary_request_carries_the_engine_key_not_the_web_token(self, monkeypatch):
        captured = {}

        async def fake_post(self, url, **kwargs):
            captured["url"] = url
            captured["headers"] = kwargs.get("headers", {})
            captured["json"] = kwargs.get("json")
            return httpx.Response(
                200,
                json={"choices": [{"message": {"content": "hello"}}]},
                request=httpx.Request("POST", url),
            )

        monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

        with build_client() as client:
            response = client.post(
                "/v1/chat/completions",
                headers={**AUTH, **JSON_CT},
                json={"messages": [{"role": "user", "content": "hi"}]},
            )

        assert response.status_code == 200
        # Forwarding the web token would leak it into the engine's log
        # and would fail the engine's own auth besides.
        assert captured["headers"]["Authorization"] == "Bearer engine-side-key"
        assert TOKEN not in json.dumps(dict(captured["headers"]))
        assert captured["url"].endswith("/v1/chat/completions")


class TestListModels:
    def test_returns_entries_with_the_loaded_alias(self):
        with build_client() as client:
            body = client.get("/api/models", headers=AUTH).json()

        assert [m["alias"] for m in body["models"]] == [
            "qwen3.5-9b-4bit",
            "bonsai-1.7b-2bit",
        ]
        assert body["loaded"] == "fake-model"
        assert body["can_switch"] is True

    def test_cached_state_is_exposed_per_entry(self):
        with build_client() as client:
            models = client.get("/api/models", headers=AUTH).json()["models"]

        by_alias = {m["alias"]: m for m in models}
        assert by_alias["qwen3.5-9b-4bit"]["cached"] is True
        assert by_alias["bonsai-1.7b-2bit"]["cached"] is False

    def test_refresh_query_forces_a_rescan(self):
        catalog = FakeCatalog()
        with build_client(catalog=catalog) as client:
            client.get("/api/models", headers=AUTH)
            client.get("/api/models?refresh=true", headers=AUTH)

        assert catalog.forced == [False, True]

    def test_attach_mode_reports_the_catalog_is_unavailable(self):
        engine = FakeEngine(can_switch=False)
        with build_client(engine, catalog=None) as client:
            response = client.get("/api/models", headers=AUTH)

        assert response.status_code == 501
        assert response.json()["error"]["type"] == "catalog_unavailable"

    def test_catalog_failure_is_surfaced_as_503(self):
        catalog = FakeCatalog(error=CatalogError("rapid-mlx not found"))
        with build_client(catalog=catalog) as client:
            response = client.get("/api/models", headers=AUTH)

        assert response.status_code == 503
        assert "rapid-mlx not found" in response.json()["error"]["message"]

    def test_listing_requires_a_token(self):
        with build_client() as client:
            assert client.get("/api/models").status_code == 401


class TestLoadModel:
    def test_switches_to_a_known_alias(self):
        engine = FakeEngine()
        with build_client(engine) as client:
            response = client.post(
                "/api/models/load",
                headers={**AUTH, **JSON_CT},
                json={"model": "bonsai-1.7b-2bit"},
            )

        assert response.status_code == 200
        body = response.json()
        # Answers immediately with "starting" rather than awaiting the
        # load: a real load takes minutes, far past any phone browser's
        # fetch timeout. The page polls /api/status for the outcome.
        assert body["state"] == "starting"
        assert body["model"] == "bonsai-1.7b-2bit"

    def test_unknown_alias_is_rejected(self):
        with build_client() as client:
            response = client.post(
                "/api/models/load",
                headers={**AUTH, **JSON_CT},
                json={"model": "no-such-model"},
            )

        assert response.status_code == 404
        assert response.json()["error"]["type"] == "unknown_model"

    def test_arbitrary_repo_is_rejected(self):
        with build_client() as client:
            response = client.post(
                "/api/models/load",
                headers={**AUTH, **JSON_CT},
                json={"model": "attacker/arbitrary-repo"},
            )

        # Passing this through would hand a remote caller a
        # general-purpose fetch primitive rather than a model picker.
        assert response.status_code == 404

    def test_reloading_the_current_model_is_a_no_op(self):
        engine = FakeEngine(model="qwen3.5-9b-4bit")
        with build_client(engine) as client:
            response = client.post(
                "/api/models/load",
                headers={**AUTH, **JSON_CT},
                json={"model": "qwen3.5-9b-4bit"},
            )

        assert response.status_code == 200
        assert response.json()["state"] == "ready"
        # Restarting would cost minutes of reload for no change, and a
        # double-tap on a phone list is easy.
        assert engine.started == []

    def test_switching_while_a_model_is_loading_is_refused(self):
        engine = FakeEngine(state=ChildState.STARTING, model="slow-model")
        with build_client(engine) as client:
            response = client.post(
                "/api/models/load",
                headers={**AUTH, **JSON_CT},
                json={"model": "bonsai-1.7b-2bit"},
            )

        assert response.status_code == 409
        assert response.json()["error"]["type"] == "busy_loading"
        assert engine.started == []

    def test_attach_mode_refuses_switching(self):
        engine = FakeEngine(can_switch=False)
        with build_client(engine, catalog=None) as client:
            response = client.post(
                "/api/models/load",
                headers={**AUTH, **JSON_CT},
                json={"model": "bonsai-1.7b-2bit"},
            )

        assert response.status_code == 409
        assert response.json()["error"]["type"] == "switch_unavailable"

    @pytest.mark.parametrize(
        "body", [{}, {"model": ""}, {"model": "   "}, {"model": 7}]
    )
    def test_invalid_bodies_are_rejected(self, body):
        with build_client() as client:
            response = client.post(
                "/api/models/load", headers={**AUTH, **JSON_CT}, json=body
            )

        assert response.status_code == 400

    def test_switching_requires_a_token(self):
        with build_client() as client:
            response = client.post(
                "/api/models/load",
                headers=JSON_CT,
                json={"model": "bonsai-1.7b-2bit"},
            )

        assert response.status_code == 401


class TestSwitchBlockedByActiveStream:
    """Switching mid-stream would kill someone else's generation.

    Most likely the person sitting at the Mac, who does not know this web
    surface exists.

    Two things these tests must avoid, both learned the hard way:

    * **Do not use ``TestClient``.** It drives the app through a single
      portal thread, so a held-open stream and a concurrent synchronous
      request can never both make progress — the test deadlocks instead
      of exercising the guard.
    * **Do not monkeypatch ``httpx.AsyncClient``.** The async test client
      is itself an ``AsyncClient``, so patching the class replaces the
      test's own transport as well as the app's, and the request never
      reaches the app at all.

    So the seam patched here is ``proxy.proxy_streaming`` — the function
    ``app.py`` actually calls. The tracker wrapping lives outside it, so
    it is still the real code under test.
    """

    @staticmethod
    def _client(app):
        # ASGITransport does NOT run the lifespan, so the shared client
        # the app opens at startup is absent. The streaming handler reads
        # it before deciding anything, so it has to exist even though the
        # patched proxy never uses it.
        app.state.http = httpx.AsyncClient()
        app.state.boot = None
        return httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver"
        )

    @pytest.mark.asyncio
    async def test_load_is_refused_while_a_chat_stream_is_relaying(self, monkeypatch):
        release = asyncio.Event()
        first_chunk = asyncio.Event()

        async def fake_streaming(client, **kwargs):
            yield b'data: {"choices":[]}\n\n'
            first_chunk.set()
            # Hold the relay open so the switch attempt below genuinely
            # overlaps with it.
            await release.wait()
            yield b"data: [DONE]\n\n"

        monkeypatch.setattr(app_module.proxy, "proxy_streaming", fake_streaming)

        engine = FakeEngine()
        app = create_app(WebConfig(token=TOKEN, engine=engine, catalog=FakeCatalog()))

        async with self._client(app) as client:
            # The stream runs as its own task rather than in a nested
            # ``async with``: ASGITransport buffers the whole response
            # before returning, so awaiting it inline would block until
            # the stream ends and the overlap under test would never
            # happen.
            relay = asyncio.create_task(
                client.post(
                    "/v1/chat/completions",
                    headers={**AUTH, **JSON_CT},
                    json={"messages": [], "stream": True},
                )
            )
            await asyncio.wait_for(first_chunk.wait(), timeout=10)

            response = await client.post(
                "/api/models/load",
                headers={**AUTH, **JSON_CT},
                json={"model": "bonsai-1.7b-2bit"},
            )
            assert response.status_code == 409
            assert response.json()["error"]["type"] == "busy_streaming"
            # The engine must be untouched: restarting it here would
            # destroy the generation still being relayed.
            assert engine.started == []

            release.set()
            await asyncio.wait_for(relay, timeout=10)

    @pytest.mark.asyncio
    async def test_the_counter_is_released_after_the_stream_finishes(self, monkeypatch):
        async def fake_streaming(client, **kwargs):
            yield b"data: [DONE]\n\n"

        monkeypatch.setattr(app_module.proxy, "proxy_streaming", fake_streaming)

        app = create_app(
            WebConfig(token=TOKEN, engine=FakeEngine(), catalog=FakeCatalog())
        )

        async with self._client(app) as client:
            await client.post(
                "/v1/chat/completions",
                headers={**AUTH, **JSON_CT},
                json={"messages": [], "stream": True},
            )

            # A leaked count would make switching impossible for the rest
            # of the session, with no way for the user to clear it.
            response = await client.post(
                "/api/models/load",
                headers={**AUTH, **JSON_CT},
                json={"model": "bonsai-1.7b-2bit"},
            )
            assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_the_counter_is_released_when_the_stream_errors(self, monkeypatch):
        async def fake_streaming(client, **kwargs):
            yield b'data: {"choices":[]}\n\n'
            raise RuntimeError("upstream vanished")

        monkeypatch.setattr(app_module.proxy, "proxy_streaming", fake_streaming)

        app = create_app(
            WebConfig(token=TOKEN, engine=FakeEngine(), catalog=FakeCatalog())
        )

        async with self._client(app) as client:
            with contextlib.suppress(Exception):
                await client.post(
                    "/v1/chat/completions",
                    headers={**AUTH, **JSON_CT},
                    json={"messages": [], "stream": True},
                )

            # The decrement has to survive a mid-stream failure too, or a
            # single dropped upstream permanently wedges switching for
            # the rest of the session.
            response = await client.post(
                "/api/models/load",
                headers={**AUTH, **JSON_CT},
                json={"model": "bonsai-1.7b-2bit"},
            )
            assert response.status_code == 200


class FakeDownloads:
    """Stands in for DownloadManager, with no subprocess."""

    def __init__(self, *, job=None, start_error=None, cancels=True):
        self._job = job
        self.start_error = start_error
        self.started = []
        self.cancelled = 0
        self._cancels = cancels

    @property
    def job(self):
        return self._job

    def is_running(self):
        return self._job is not None and self._job.state is DownloadState.RUNNING

    async def start(self, alias, *, total_bytes):
        if self.start_error:
            raise self.start_error
        self.started.append((alias, total_bytes))
        self._job = DownloadJob(alias=alias, total_bytes=total_bytes)
        return self._job

    async def cancel(self):
        self.cancelled += 1
        return self._cancels

    async def shutdown(self):
        return None

    async def wait_for_change(self, timeout):
        # Model the real manager: block until something changes. A fake
        # that returns instantly turns the SSE loop into a busy spin,
        # which hangs the test rather than exercising it.
        await asyncio.sleep(min(timeout, 0.05))


class TestPullGates:
    def test_downloads_disabled_is_refused(self):
        with build_client(downloads=None) as client:
            response = client.post(
                "/api/models/pull",
                headers={**AUTH, **JSON_CT},
                json={"model": "bonsai-1.7b-2bit"},
            )

        assert response.status_code == 403
        assert response.json()["error"]["type"] == "downloads_disabled"

    def test_unknown_alias_is_refused(self):
        with build_client(downloads=FakeDownloads()) as client:
            response = client.post(
                "/api/models/pull",
                headers={**AUTH, **JSON_CT},
                json={"model": "attacker/arbitrary-repo"},
            )

        # Accepting this would hand a remote caller a general-purpose
        # remote fetch primitive.
        assert response.status_code == 404
        assert response.json()["error"]["type"] == "unknown_model"

    def test_unknown_size_is_refused_rather_than_guessed(self):
        catalog = FakeCatalog(
            entries=[
                ModelEntry(
                    alias="sizeless",
                    hf_path="org/sizeless",
                    size_bytes=None,
                    cached=False,
                )
            ]
        )
        with build_client(catalog=catalog, downloads=FakeDownloads()) as client:
            response = client.post(
                "/api/models/pull",
                headers={**AUTH, **JSON_CT},
                json={"model": "sizeless"},
            )

        # model_sizes.json genuinely lacks entries for some repos.
        # Treating "unknown" as "small" is how a reachable endpoint
        # fills the host's disk.
        assert response.status_code == 507
        assert response.json()["error"]["type"] == "insufficient_storage"

    def test_insufficient_space_is_refused(self, monkeypatch):
        monkeypatch.setattr(
            app_module, "check_disk_budget", lambda size: "not enough free space: ..."
        )
        downloads = FakeDownloads()
        with build_client(downloads=downloads) as client:
            response = client.post(
                "/api/models/pull",
                headers={**AUTH, **JSON_CT},
                json={"model": "bonsai-1.7b-2bit"},
            )

        assert response.status_code == 507
        assert downloads.started == []

    def test_a_valid_pull_starts(self, monkeypatch):
        monkeypatch.setattr(app_module, "check_disk_budget", lambda size: None)
        downloads = FakeDownloads()
        with build_client(downloads=downloads) as client:
            response = client.post(
                "/api/models/pull",
                headers={**AUTH, **JSON_CT},
                json={"model": "bonsai-1.7b-2bit"},
            )

        assert response.status_code == 200
        assert response.json()["state"] == "running"
        assert downloads.started == [("bonsai-1.7b-2bit", 495525300)]

    def test_a_second_concurrent_pull_is_refused(self, monkeypatch):
        monkeypatch.setattr(app_module, "check_disk_budget", lambda size: None)
        downloads = FakeDownloads(
            start_error=DownloadError("a download is already running (x)")
        )
        with build_client(downloads=downloads) as client:
            response = client.post(
                "/api/models/pull",
                headers={**AUTH, **JSON_CT},
                json={"model": "bonsai-1.7b-2bit"},
            )

        assert response.status_code == 409
        assert response.json()["error"]["type"] == "download_conflict"

    def test_pull_requires_a_token(self):
        with build_client(downloads=FakeDownloads()) as client:
            response = client.post(
                "/api/models/pull", headers=JSON_CT, json={"model": "x"}
            )

        assert response.status_code == 401

    @pytest.mark.parametrize("body", [{}, {"model": ""}, {"model": 7}])
    def test_invalid_bodies_are_rejected(self, body):
        with build_client(downloads=FakeDownloads()) as client:
            response = client.post(
                "/api/models/pull", headers={**AUTH, **JSON_CT}, json=body
            )

        assert response.status_code == 400


class TestCancelDownload:
    def test_cancel_stops_a_running_download(self):
        downloads = FakeDownloads()
        with build_client(downloads=downloads) as client:
            response = client.post(
                "/api/downloads/cancel", headers={**AUTH, **JSON_CT}, json={}
            )

        assert response.status_code == 200
        assert downloads.cancelled == 1

    def test_cancel_with_nothing_running_is_a_conflict(self):
        downloads = FakeDownloads(cancels=False)
        with build_client(downloads=downloads) as client:
            response = client.post(
                "/api/downloads/cancel", headers={**AUTH, **JSON_CT}, json={}
            )

        assert response.status_code == 409
        assert response.json()["error"]["type"] == "no_download"

    def test_cancel_is_refused_when_downloads_are_disabled(self):
        with build_client(downloads=None) as client:
            response = client.post(
                "/api/downloads/cancel", headers={**AUTH, **JSON_CT}, json={}
            )

        assert response.status_code == 403


class TestDownloadCapabilityReporting:
    def test_auth_reports_whether_downloads_are_allowed(self):
        with build_client(downloads=FakeDownloads()) as client:
            body = client.post("/api/auth", headers={**AUTH, **JSON_CT}, json={}).json()
        assert body["allow_downloads"] is True

        with build_client(downloads=None) as client:
            body = client.post("/api/auth", headers={**AUTH, **JSON_CT}, json={}).json()
        # The page uses this to decide whether tapping an uncached model
        # can do anything, so it must match what the routes enforce.
        assert body["allow_downloads"] is False

    def test_models_reports_whether_downloads_are_allowed(self):
        with build_client(downloads=FakeDownloads()) as client:
            body = client.get("/api/models", headers=AUTH).json()
        assert body["allow_downloads"] is True


class TestDownloadStream:
    """The SSE feed must survive a job reaching a terminal state.

    An earlier version closed the stream on ``done``/``cancelled``. That
    looks right until the second download: the manager keeps the last
    finished job, so a client connecting afterwards immediately saw the
    terminal frame, got ``[DONE]``, and the connection closed — leaving
    a newly started download with no live feed and the page showing no
    progress at all. Caught in end-to-end testing, not by the unit tests
    that existed at the time.

    The generator is driven directly rather than through an HTTP client.
    ``httpx.ASGITransport`` buffers a response to completion before
    returning it, so an endless SSE feed never yields a first chunk and
    the test hangs instead of asserting anything.
    """

    @staticmethod
    def _events(downloads):
        request = SimpleNamespace(is_disconnected=_never_disconnected)
        return app_module._download_events(downloads, request)

    @pytest.mark.asyncio
    async def test_a_terminal_job_does_not_close_the_feed(self):
        finished = DownloadJob(alias="already-done", total_bytes=100)
        finished.state = DownloadState.DONE
        finished.done_bytes = 100

        events = self._events(FakeDownloads(job=finished))

        first = await asyncio.wait_for(anext(events), timeout=5)
        assert b"already-done" in first
        assert b"[DONE]" not in first

        # Still live: a client that arrives after a finished download has
        # to be able to watch the next one on the same connection. With
        # nothing changing the server emits a keepalive comment frame,
        # which is proof the loop did not terminate.
        second = await asyncio.wait_for(anext(events), timeout=5)
        assert second.startswith(b":")

        await events.aclose()

    @pytest.mark.asyncio
    async def test_a_new_download_is_reported_on_an_existing_feed(self):
        finished = DownloadJob(alias="already-done", total_bytes=100)
        finished.state = DownloadState.DONE

        downloads = FakeDownloads(job=finished)
        events = self._events(downloads)

        await asyncio.wait_for(anext(events), timeout=5)

        # The exact case the closed-on-terminal bug broke.
        await downloads.start("next-model", total_bytes=500)
        frames = []
        for _ in range(3):
            frames.append(await asyncio.wait_for(anext(events), timeout=5))
            if b"next-model" in frames[-1]:
                break

        assert any(b"next-model" in frame for frame in frames)
        await events.aclose()

    @pytest.mark.asyncio
    async def test_an_idle_manager_reports_idle(self):
        events = self._events(FakeDownloads(job=None))
        first = await asyncio.wait_for(anext(events), timeout=5)
        assert b'"idle"' in first
        await events.aclose()

    @pytest.mark.asyncio
    async def test_a_disconnected_client_ends_the_feed(self):
        async def disconnected():
            return True

        request = SimpleNamespace(is_disconnected=disconnected)
        events = app_module._download_events(FakeDownloads(), request)

        # Without this the generator would keep polling the manager for a
        # client that is gone.
        with pytest.raises(StopAsyncIteration):
            await asyncio.wait_for(anext(events), timeout=5)

    def test_the_stream_requires_a_token(self):
        with build_client(downloads=FakeDownloads()) as client:
            assert client.get("/api/downloads/stream").status_code == 401

    def test_the_stream_is_refused_when_downloads_are_disabled(self):
        with build_client(downloads=None) as client:
            response = client.get("/api/downloads/stream", headers=AUTH)
        assert response.status_code == 403


class TestNoAuthMode:
    """``token=None`` disables the bearer, for a loopback bind only.

    The thing worth pinning here is what does *not* get disabled with
    it. Without a token, the Origin and content-type checks become the
    only barrier between this port and any web page the user happens to
    have open — a page can reach a loopback port through the browser
    even though it cannot reach the network the port is on.
    """

    def test_api_is_reachable_without_a_token(self):
        with build_client(token=None) as client:
            response = client.get("/api/status")
        assert response.status_code == 200

    def test_a_stray_authorization_header_is_ignored(self):
        # A phone with a token cached from an earlier authenticated run
        # must not be locked out when the server is restarted without one.
        with build_client(token=None) as client:
            response = client.get(
                "/api/status", headers={"Authorization": "Bearer leftover"}
            )
        assert response.status_code == 200

    def test_cross_site_requests_are_still_refused(self):
        with build_client(token=None) as client:
            response = client.post(
                "/api/models/load",
                headers={
                    **JSON_CT,
                    "Origin": "https://evil.example",
                    "Sec-Fetch-Site": "cross-site",
                },
                json={"model": "bonsai-1.7b-2bit"},
            )
        # The whole point: with no token this is the only control left.
        assert response.status_code == 403
        assert response.json()["error"]["type"] == "origin_refused"

    def test_simple_content_types_are_still_refused(self):
        with build_client(token=None) as client:
            response = client.post(
                "/api/models/load",
                headers={"Content-Type": "text/plain"},
                content='{"model": "bonsai-1.7b-2bit"}',
            )
        # text/plain is a CORS "simple" type: a cross-origin page can
        # send it with no preflight.
        assert response.status_code == 415

    def test_downloads_are_still_gated(self, monkeypatch):
        monkeypatch.setattr(app_module, "check_disk_budget", lambda size: None)
        with build_client(token=None, downloads=None) as client:
            response = client.post(
                "/api/models/pull",
                headers=JSON_CT,
                json={"model": "bonsai-1.7b-2bit"},
            )
        assert response.status_code == 403

    def test_unknown_aliases_are_still_refused(self):
        with build_client(token=None) as client:
            response = client.post(
                "/api/models/load",
                headers=JSON_CT,
                json={"model": "attacker/arbitrary-repo"},
            )
        assert response.status_code == 404


class TestPublicConfig:
    """``/api/config`` is the one unauthenticated JSON endpoint."""

    def test_reports_auth_required_when_a_token_is_set(self):
        with build_client() as client:
            body = client.get("/api/config").json()
        assert body == {"auth_required": True}

    def test_reports_no_auth_when_the_token_is_disabled(self):
        with build_client(token=None) as client:
            body = client.get("/api/config").json()
        assert body == {"auth_required": False}

    def test_is_reachable_without_a_token(self):
        # The page needs this before it can decide whether to show a
        # login prompt, so it cannot itself be behind the prompt.
        with build_client() as client:
            assert client.get("/api/config").status_code == 200

    def test_leaks_nothing_beyond_the_auth_flag(self):
        engine = FakeEngine(model="secret-model-name")
        with build_client(engine) as client:
            body = client.get("/api/config").json()
        # An unauthenticated caller must not learn which model is loaded,
        # what the catalog holds, or anything about the host.
        assert list(body.keys()) == ["auth_required"]
        assert "secret-model-name" not in json.dumps(body)
