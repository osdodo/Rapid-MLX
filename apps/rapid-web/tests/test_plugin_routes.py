# SPDX-License-Identifier: Apache-2.0
"""The ``/api/plugins`` surface, and how plugin tools reach ``/api/tools/call``.

Specs are registered in memory. Discovery is never exercised here: it reads
``sys.path``, so a test that relied on it would answer to whatever the
developer has installed.
"""

from __future__ import annotations

import json

import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient
from test_app import AUTH, JSON_CT, TOKEN, FakeCatalog, FakeEngine

from rmlx_web.app import WebConfig, create_app
from rmlx_web.connectors import ConnectorStore
from rmlx_web.plugins import (
    ConfigField,
    PluginContext,
    PluginRegistry,
    PluginSpec,
    PluginTool,
)

HEADERS = {**JSON_CT, **AUTH}


async def echo(context: PluginContext, args: dict) -> str:
    return f"{context.config.get('prefix', '')}{args.get('text', '')}"


def demo_router() -> APIRouter:
    router = APIRouter()

    @router.get("/ping")
    async def ping() -> dict:
        return {"pong": True}

    return router


def demo_spec(**overrides) -> PluginSpec:
    fields = {
        "name": "demo",
        "title": "Demo",
        "description": "A plugin.",
        "tools": [
            PluginTool(
                name="echo",
                description="Echo the text back.",
                parameters={
                    "type": "object",
                    "properties": {"text": {"type": "string"}},
                },
                handler=echo,
            )
        ],
        "config": [
            ConfigField(key="prefix", label="Prefix"),
            ConfigField(key="token", label="API token", kind="secret", required=True),
        ],
        "router": demo_router(),
    }
    fields.update(overrides)
    return PluginSpec(**fields)


@pytest.fixture
def registry(tmp_path) -> PluginRegistry:
    store = PluginRegistry(settings_path=tmp_path / "plugins.json")
    store.register_spec(demo_spec(), version="1.0.0")
    return store


def build(registry, tmp_path) -> TestClient:
    return TestClient(
        create_app(
            WebConfig(
                token=TOKEN,
                engine=FakeEngine(),
                catalog=FakeCatalog(),
                connectors=ConnectorStore(
                    config_path=tmp_path / "mcp.json",
                    settings_path=tmp_path / "rmlx-web.json",
                ),
                plugins=registry,
            )
        )
    )


def settings(client, patch):
    return client.post("/api/plugins/settings", headers=HEADERS, json=patch)


def call(client, name, arguments="{}", advertised=None):
    return client.post(
        "/api/tools/call",
        headers=HEADERS,
        json={
            "name": name,
            "arguments": arguments,
            "advertised": advertised if advertised is not None else [name],
        },
    )


# ---------------------------------------------------------------------- auth


def test_the_plugin_surface_requires_the_bearer(registry, tmp_path):
    """No Origin is normal for scripts, so the bearer is the boundary."""
    with build(registry, tmp_path) as client:
        read = client.get("/api/plugins")
        write = client.post(
            "/api/plugins/settings",
            headers=JSON_CT,
            json={"plugin": "demo", "enabled": True},
        )
        route = client.get("/api/plugins/demo/ping")

    assert [read.status_code, write.status_code, route.status_code] == [401, 401, 401]
    assert registry.is_enabled("demo") is False


def test_a_plugin_route_inherits_the_content_type_rule(registry, tmp_path):
    with build(registry, tmp_path) as client:
        response = client.post(
            "/api/plugins/settings",
            headers={**AUTH, "Content-Type": "text/plain"},
            content="x",
        )

    assert response.status_code == 415


def test_a_cross_origin_request_is_refused(registry, tmp_path):
    with build(registry, tmp_path) as client:
        response = client.get(
            "/api/plugins", headers={**AUTH, "Origin": "https://evil.example"}
        )

    assert response.status_code == 403


# ------------------------------------------------------------------ snapshot


def test_the_snapshot_reports_a_plugin_off_and_unconfigured(registry, tmp_path):
    with build(registry, tmp_path) as client:
        body = client.get("/api/plugins", headers=AUTH).json()

    plugin = body["plugins"][0]

    assert plugin["name"] == "demo"
    assert plugin["version"] == "1.0.0"
    assert plugin["enabled"] is False
    assert plugin["config_complete"] is False
    assert plugin["has_router"] is True
    assert [t["name"] for t in plugin["tools"]] == ["demo__echo"]


def test_load_errors_are_surfaced(tmp_path):
    store = PluginRegistry(settings_path=tmp_path / "plugins.json")
    store.register_spec(demo_spec(name="has space"))

    with build(store, tmp_path) as client:
        body = client.get("/api/plugins", headers=AUTH).json()

    assert body["plugins"] == []
    assert len(body["load_errors"]) == 1


# ------------------------------------------------------------------ switches


def test_enabling_takes_effect_at_once(registry, tmp_path):
    with build(registry, tmp_path) as client:
        body = settings(client, {"plugin": "demo", "enabled": True}).json()

    assert body["plugins"][0]["enabled"] is True


def test_a_per_tool_switch_leaves_its_siblings_alone(tmp_path):
    store = PluginRegistry(settings_path=tmp_path / "plugins.json")
    store.register_spec(
        demo_spec(
            tools=[
                PluginTool(
                    name=name,
                    description="d",
                    parameters={"type": "object", "properties": {}},
                    handler=echo,
                )
                for name in ("one", "two")
            ]
        )
    )

    with build(store, tmp_path) as client:
        settings(client, {"plugin": "demo", "enabled": True})
        body = settings(client, {"tool": "demo__one", "tool_enabled": False}).json()

    assert body["disabled_tools"] == ["demo__one"]
    assert {t["name"]: t["enabled"] for t in body["plugins"][0]["tools"]} == {
        "demo__one": False,
        "demo__two": True,
    }


def test_a_grant_round_trips(registry, tmp_path):
    with build(registry, tmp_path) as client:
        granted = settings(client, {"tool": "demo__echo", "grant": True}).json()
        cleared = settings(client, {"reset_grants": True}).json()

    assert granted["granted_tools"] == ["demo__echo"]
    assert cleared["granted_tools"] == []


def test_an_unknown_plugin_is_a_400(registry, tmp_path):
    with build(registry, tmp_path) as client:
        response = settings(client, {"plugin": "nope", "enabled": True})

    assert response.status_code == 400


# -------------------------------------------------------------------- config


def test_a_secret_is_stored_but_never_returned(registry, tmp_path):
    with build(registry, tmp_path) as client:
        body = settings(
            client, {"plugin": "demo", "config": {"token": "sk-do-not-echo"}}
        ).json()

    field = next(f for f in body["plugins"][0]["config"] if f["key"] == "token")

    assert field["has_value"] is True
    assert "value" not in field
    assert "sk-do-not-echo" not in json.dumps(body)
    assert body["plugins"][0]["config_complete"] is True


def test_an_illegal_config_value_is_a_400(registry, tmp_path):
    """The same body is reachable with curl plus the bearer."""
    with build(registry, tmp_path) as client:
        response = settings(client, {"plugin": "demo", "config": {"prefix": 42}})

    assert response.status_code == 400
    assert response.json()["error"]["type"] == "invalid_body"


def test_an_undeclared_config_key_is_a_400(registry, tmp_path):
    with build(registry, tmp_path) as client:
        response = settings(client, {"plugin": "demo", "config": {"nope": "x"}})

    assert response.status_code == 400


# ------------------------------------------------------------------ dispatch


def test_a_plugin_tool_runs_through_the_shared_route(registry, tmp_path):
    """`/api/tools/call`, not a plugin-specific endpoint: that route already
    carries the `advertised` gate, and a second copy is the one that drifts."""
    with build(registry, tmp_path) as client:
        settings(client, {"plugin": "demo", "enabled": True})
        settings(client, {"plugin": "demo", "config": {"prefix": ">> ", "token": "t"}})
        body = call(client, "demo__echo", '{"text": "hi"}').json()

    assert body == {"content": ">> hi", "is_error": False}


def test_a_plugin_tool_is_refused_when_not_advertised(registry, tmp_path):
    with build(registry, tmp_path) as client:
        settings(client, {"plugin": "demo", "enabled": True})
        settings(client, {"plugin": "demo", "config": {"token": "t"}})
        body = call(client, "demo__echo", advertised=["weather"]).json()

    assert body["is_error"] is True
    assert "unknown tool" in body["content"]


def test_a_disabled_plugin_refuses_the_call(registry, tmp_path):
    with build(registry, tmp_path) as client:
        body = call(client, "demo__echo", '{"text": "hi"}').json()

    assert body["is_error"] is True
    assert "turned off in Settings" in body["content"]


def test_the_built_in_tools_are_untouched(registry, tmp_path):
    """`/api/tools` is cached for the page's lifetime, so it must stay
    constant for the process — plugins live on their own endpoint."""
    with build(registry, tmp_path) as client:
        settings(client, {"plugin": "demo", "enabled": True})
        body = client.get("/api/tools", headers=AUTH).json()

    assert [t["function"]["name"] for t in body["tools"]] == [
        "web_search",
        "browse",
        "weather",
    ]


def test_an_unknown_advertised_tool_answers_rather_than_500ing(registry, tmp_path):
    """`advertised` is the page's claim, not a subset of what is installed: a
    plugin switched off mid-turn leaves a name nothing here recognises."""
    with build(registry, tmp_path) as client:
        response = call(client, "ghost")

    assert response.status_code == 200
    assert response.json()["is_error"] is True


# -------------------------------------------------------------------- router


def test_a_plugin_route_serves_when_enabled_and_refuses_when_off(registry, tmp_path):
    """Starlette builds its router at startup and has no supported removal, so
    the switch is enforced per request rather than by unmounting."""
    with build(registry, tmp_path) as client:
        off = client.get("/api/plugins/demo/ping", headers=AUTH)
        settings(client, {"plugin": "demo", "enabled": True})
        on = client.get("/api/plugins/demo/ping", headers=AUTH)

    assert off.status_code == 409
    assert on.json() == {"pong": True}


def test_the_management_route_wins_over_a_plugin_named_settings(tmp_path):
    """`settings` is refused as a plugin name, so the collision cannot arise —
    and the management routes are registered first regardless."""
    store = PluginRegistry(settings_path=tmp_path / "plugins.json")
    store.register_spec(demo_spec(name="settings"))

    with build(store, tmp_path) as client:
        response = settings(client, {"reset_grants": True})

    assert response.status_code == 200
    assert store.loaded == []


def test_the_static_mount_still_resolves_with_routers_registered(registry, tmp_path):
    """A mount swallows its prefix, so it has to stay last."""
    with build(registry, tmp_path) as client:
        asset = client.get("/static/assets/definitely-missing.js")
        index = client.get("/")

    assert asset.status_code == 404
    assert index.status_code == 200
