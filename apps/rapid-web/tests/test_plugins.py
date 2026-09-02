# SPDX-License-Identifier: Apache-2.0
"""The plugin registry: what it accepts, what it drops, and what it stores.

Every spec here is constructed in memory. Nothing depends on a plugin being
installed, because ``entry_points()`` reads ``sys.path`` and no fixture
isolates that — a test that trusted discovery would pass or fail according to
what the developer happens to have in their venv.
"""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest
from fastapi import APIRouter

from rmlx_web.plugins import (
    ConfigField,
    PluginContext,
    PluginError,
    PluginRegistry,
    PluginSpec,
    PluginTool,
    run_plugin_tool,
)
from rmlx_web.tools import ToolError


async def echo(context: PluginContext, args: dict) -> str:
    return f"{context.config.get('prefix', '')}{args.get('text', '')}"


def tool(name: str = "echo", **overrides) -> PluginTool:
    fields = {
        "name": name,
        "description": "Echo the text back.",
        "parameters": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
        },
        "handler": echo,
    }
    fields.update(overrides)
    return PluginTool(**fields)


def spec(name: str = "demo", **overrides) -> PluginSpec:
    fields = {
        "name": name,
        "title": "Demo",
        "description": "A plugin.",
        "tools": [tool()],
    }
    fields.update(overrides)
    return PluginSpec(**fields)


@pytest.fixture
def registry(tmp_path) -> PluginRegistry:
    return PluginRegistry(settings_path=tmp_path / "plugins.json")


def messages(registry: PluginRegistry) -> str:
    return " | ".join(f"{e.name}: {e.message}" for e in registry.load_errors)


def call(registry, name, arguments="{}", advertised=None):
    async def run():
        async with httpx.AsyncClient() as client:
            return await run_plugin_tool(
                registry,
                client,
                name=name,
                arguments=arguments,
                advertised=set(advertised if advertised is not None else [name]),
            )

    return asyncio.run(run())


# ------------------------------------------------------------- registration


def test_a_valid_spec_registers_its_tools_namespaced(registry):
    registry.register_spec(spec())

    assert registry.tool_names() == {"demo__echo"}
    assert registry.load_errors == []


def test_the_plugin_owns_its_tool_whatever_the_switches_say(registry):
    """A switched-off tool must still route to the plugin refusal.

    Otherwise the call falls through to the built-in path and is reported as
    an unknown tool, which tells the model nothing it can act on.
    """
    registry.register_spec(spec())

    assert registry.owns("demo__echo")
    assert not registry.is_enabled("demo")


@pytest.mark.parametrize(
    ("name", "reason"),
    [
        ("", "no name"),
        ("x" * 25, "longer than"),
        ("my__plugin", "cannot contain"),
        ("has space", "letters, numbers"),
        ("settings", "reserved"),
    ],
)
def test_an_unusable_plugin_name_is_refused(registry, name, reason):
    registry.register_spec(spec(name=name))

    assert registry.tool_names() == set()
    assert reason in messages(registry)


def test_a_duplicate_plugin_name_loses_to_the_first(registry):
    registry.register_spec(spec(title="First"))
    registry.register_spec(spec(title="Second"))

    assert [p.spec.title for p in registry.loaded] == ["First"]
    assert "already registered" in messages(registry)


def test_a_sync_handler_drops_only_that_tool(registry):
    """One blocking call would stall SSE relay for every open tab."""

    def blocking(context, args):
        return "no"

    registry.register_spec(spec(tools=[tool(), tool("slow", handler=blocking)]))

    assert registry.tool_names() == {"demo__echo"}
    assert "not an async function" in messages(registry)


def test_a_non_object_schema_drops_only_that_tool(registry):
    """The engine rejects the whole tools array over one malformed entry."""
    registry.register_spec(
        spec(tools=[tool(), tool("bad", parameters={"type": "string"})])
    )

    assert registry.tool_names() == {"demo__echo"}
    assert "not a JSON Schema object" in messages(registry)


def test_an_overlong_composite_name_drops_only_that_tool(registry):
    registry.register_spec(spec(tools=[tool(), tool("x" * 80)]))

    assert registry.tool_names() == {"demo__echo"}
    assert "at most 64 characters" in messages(registry)


def test_an_overlong_name_is_truncated_in_its_own_error(registry):
    """The name is the fault being reported, so it must not flood the line."""
    registry.register_spec(spec(tools=[tool("x" * 80)]))

    assert "…" in messages(registry)
    assert "x" * 40 not in messages(registry)


def test_a_built_in_name_cannot_be_shadowed(registry):
    """Not by a check, but by construction: every composite contains `__`,
    which no built-in name does. A plugin trying to be called `weather` gets
    `weather__weather`, which collides with nothing."""
    registry.register_spec(
        PluginSpec(name="weather", title="W", tools=[tool("weather"), tool("browse")])
    )

    assert registry.tool_names() == {"weather__weather", "weather__browse"}
    assert registry.tool_names().isdisjoint({"weather", "browse", "web_search"})


def test_a_second_plugin_cannot_take_a_registered_composite(registry):
    registry.register_spec(spec(name="alpha", tools=[tool("one"), tool("one")]))

    assert registry.tool_names() == {"alpha__one"}
    assert "already taken" in messages(registry)


def test_two_plugins_may_share_a_bare_tool_name(registry):
    registry.register_spec(spec(name="alpha"))
    registry.register_spec(spec(name="beta"))

    assert registry.tool_names() == {"alpha__echo", "beta__echo"}


def test_a_non_router_is_ignored_but_the_tools_survive(registry):
    registry.register_spec(spec(router="not a router"))

    assert registry.tool_names() == {"demo__echo"}
    assert registry.loaded[0].spec.router is None
    assert "not a fastapi APIRouter" in messages(registry)


def test_a_real_router_is_kept(registry):
    registry.register_spec(spec(router=APIRouter()))

    assert registry.loaded[0].spec.router is not None
    assert registry.load_errors == []


def test_a_duplicate_config_key_refuses_the_plugin(registry):
    registry.register_spec(
        spec(config=[ConfigField(key="k", label="K"), ConfigField(key="k", label="K")])
    )

    assert registry.tool_names() == set()
    assert "declared twice" in messages(registry)


def test_an_enum_without_choices_refuses_the_plugin(registry):
    registry.register_spec(
        spec(config=[ConfigField(key="mode", label="Mode", kind="enum")])
    )

    assert "enum with no choices" in messages(registry)


# ------------------------------------------------------------- advertising


def test_nothing_is_advertised_until_the_plugin_is_enabled(registry):
    registry.register_spec(spec())

    assert registry.definitions() == []

    registry.set_enabled("demo", True)

    assert [d["function"]["name"] for d in registry.definitions()] == ["demo__echo"]


def test_a_disabled_tool_is_not_advertised(registry):
    registry.register_spec(spec(tools=[tool(), tool("other")]))
    registry.set_enabled("demo", True)
    registry.set_tool_enabled("demo__echo", False)

    assert [d["function"]["name"] for d in registry.definitions()] == ["demo__other"]


def test_approval_required_is_reported_per_tool(registry):
    registry.register_spec(spec(tools=[tool(), tool("gated", requires_approval=True)]))

    assert registry.approval_required() == {"demo__gated"}


def test_a_declared_title_is_what_the_panel_shows(registry):
    registry.register_spec(spec(tools=[tool(title="Echo It Back")]))

    assert registry.snapshot()["plugins"][0]["tools"][0]["title"] == "Echo It Back"


def test_a_tool_without_a_title_falls_back_to_its_bare_name(registry):
    """Resolved here rather than in the page, so there is one fallback rather
    than one per place that renders a tool."""
    registry.register_spec(spec())

    assert registry.snapshot()["plugins"][0]["tools"][0]["title"] == "echo"


def test_a_non_text_title_drops_only_that_tool(registry):
    registry.register_spec(spec(tools=[tool(), tool("bad", title=42)]))

    assert registry.tool_names() == {"demo__echo"}
    assert "title that is not text" in messages(registry)


# ------------------------------------------------------------------ config


def test_a_declared_default_is_resolved_without_being_stored(registry):
    registry.register_spec(
        spec(config=[ConfigField(key="mode", label="Mode", default="fast")])
    )

    assert registry.config_for("demo") == {"mode": "fast"}


def test_a_required_field_is_missing_until_it_has_a_value(registry):
    registry.register_spec(
        spec(config=[ConfigField(key="token", label="Token", required=True)])
    )

    assert [f.key for f in registry.missing_config("demo")] == ["token"]

    registry.set_config("demo", {"token": "abc"})

    assert registry.missing_config("demo") == []


def test_whitespace_does_not_satisfy_a_required_field(registry):
    registry.register_spec(
        spec(config=[ConfigField(key="token", label="Token", required=True)])
    )
    registry.set_config("demo", {"token": "   "})

    assert [f.key for f in registry.missing_config("demo")] == ["token"]


def test_a_secret_is_never_in_the_snapshot(registry):
    registry.register_spec(
        spec(config=[ConfigField(key="token", label="Token", kind="secret")])
    )
    registry.set_config("demo", {"token": "sk-do-not-echo"})

    field = registry.snapshot()["plugins"][0]["config"][0]

    assert field["has_value"] is True
    assert "value" not in field
    assert "sk-do-not-echo" not in json.dumps(registry.snapshot())


def test_an_absent_secret_key_leaves_the_stored_value_alone(registry):
    """The form only sends a secret the user actually typed."""
    registry.register_spec(
        spec(
            config=[
                ConfigField(key="token", label="Token", kind="secret"),
                ConfigField(key="prefix", label="Prefix"),
            ]
        )
    )
    registry.set_config("demo", {"token": "kept"})
    registry.set_config("demo", {"prefix": ">> "})

    assert registry.config_for("demo")["token"] == "kept"


def test_an_empty_secret_clears_it(registry):
    registry.register_spec(
        spec(config=[ConfigField(key="token", label="Token", kind="secret")])
    )
    registry.set_config("demo", {"token": "gone"})
    registry.set_config("demo", {"token": ""})

    assert "token" not in registry.config_for("demo")


def test_an_undeclared_config_key_is_refused(registry):
    registry.register_spec(spec())

    with pytest.raises(PluginError, match="no setting called"):
        registry.set_config("demo", {"whatever": 1})


@pytest.mark.parametrize(
    ("field", "value", "reason"),
    [
        (ConfigField(key="k", label="K"), 42, "must be text"),
        (ConfigField(key="k", label="K", kind="number"), "12", "must be a number"),
        (ConfigField(key="k", label="K", kind="number"), True, "must be a number"),
        (
            ConfigField(key="k", label="K", kind="number"),
            float("inf"),
            "finite",
        ),
        (ConfigField(key="k", label="K", kind="boolean"), "yes", "true or false"),
        (
            ConfigField(key="k", label="K", kind="enum", choices=[("a", "A")]),
            "b",
            "must be one of",
        ),
    ],
)
def test_a_value_of_the_wrong_kind_is_refused(registry, field, value, reason):
    """The browser's form is not the check: curl plus the bearer reaches this."""
    registry.register_spec(spec(config=[field]))

    with pytest.raises(PluginError, match=reason):
        registry.set_config("demo", {"k": value})


# ------------------------------------------------------------- persistence


def test_state_survives_a_restart(registry, tmp_path):
    registry.register_spec(spec(config=[ConfigField(key="prefix", label="P")]))
    registry.set_enabled("demo", True)
    registry.set_config("demo", {"prefix": ">> "})

    restarted = PluginRegistry(settings_path=tmp_path / "plugins.json")
    restarted.register_spec(spec(config=[ConfigField(key="prefix", label="P")]))

    assert restarted.is_enabled("demo")
    assert restarted.config_for("demo") == {"prefix": ">> "}


def test_the_settings_file_is_private(registry, tmp_path):
    registry.register_spec(spec())
    registry.set_enabled("demo", True)

    path = tmp_path / "plugins.json"

    assert path.stat().st_mode & 0o777 == 0o600
    assert path.parent.stat().st_mode & 0o777 == 0o700


def test_a_grant_persists_and_can_be_reset(registry):
    registry.register_spec(spec())
    registry.grant_tool("demo__echo")

    assert registry.granted_tools() == {"demo__echo"}

    registry.reset_grants()

    assert registry.granted_tools() == set()


def test_granting_an_unknown_tool_is_refused(registry):
    registry.register_spec(spec())

    with pytest.raises(PluginError, match="No plugin tool"):
        registry.grant_tool("demo__nope")


def test_an_upgraded_plugin_loses_its_grants(registry, tmp_path):
    """Consent was given to the code that was installed, not to the name."""
    (tmp_path / "plugins.json").write_text(
        json.dumps(
            {
                "grantedTools": ["demo__echo", "other__keep"],
                "versions": {"demo": "0.0.9"},
            }
        )
    )
    fresh = PluginRegistry(settings_path=tmp_path / "plugins.json")
    fresh.register_spec(spec(), version="1.0.0")
    fresh._reconcile_grants()

    assert fresh.granted_tools() == {"other__keep"}


def test_a_first_install_records_its_version_without_revoking(registry):
    registry.register_spec(spec(), version="1.0.0")
    registry.grant_tool("demo__echo")
    registry._reconcile_grants()

    assert registry.granted_tools() == {"demo__echo"}


def test_an_unreadable_settings_file_does_not_raise(tmp_path):
    path = tmp_path / "plugins.json"
    path.write_text("{ not json")

    assert PluginRegistry(settings_path=path).granted_tools() == set()


# ---------------------------------------------------------------- dispatch


def test_a_tool_runs_with_its_config(registry):
    registry.register_spec(spec(config=[ConfigField(key="prefix", label="P")]))
    registry.set_enabled("demo", True)
    registry.set_config("demo", {"prefix": ">> "})

    result = call(registry, "demo__echo", '{"text": "hi"}')

    assert result.content == ">> hi"
    assert result.is_error is False


def test_a_tool_not_in_advertised_is_refused(registry):
    """The load-bearing gate: omitting a tool does not stop a model naming it."""
    registry.register_spec(spec())
    registry.set_enabled("demo", True)

    result = call(registry, "demo__echo", advertised=["weather"])

    assert result.is_error
    assert "unknown tool" in result.content


def test_a_disabled_plugin_refuses_and_names_the_switch(registry):
    registry.register_spec(spec())

    result = call(registry, "demo__echo", '{"text": "hi"}')

    assert result.is_error
    assert "turned off in Settings" in result.content


def test_a_disabled_tool_refuses(registry):
    registry.register_spec(spec())
    registry.set_enabled("demo", True)
    registry.set_tool_enabled("demo__echo", False)

    result = call(registry, "demo__echo", '{"text": "hi"}')

    assert result.is_error
    assert "switched off" in result.content


def test_missing_required_config_refuses_and_names_the_field(registry):
    """Never call a handler short a required field: its KeyError names a dict
    key the user cannot act on."""
    registry.register_spec(
        spec(config=[ConfigField(key="token", label="API token", required=True)])
    )
    registry.set_enabled("demo", True)

    result = call(registry, "demo__echo", '{"text": "hi"}')

    assert result.is_error
    assert "API token" in result.content


def test_arguments_outside_the_schema_are_dropped(registry):
    seen = {}

    async def capture(context, args):
        seen.update(args)
        return "ok"

    registry.register_spec(spec(tools=[tool(handler=capture)]))
    registry.set_enabled("demo", True)
    call(registry, "demo__echo", '{"text": "hi", "injected": "x"}')

    assert seen == {"text": "hi"}


def test_malformed_arguments_are_refused(registry):
    registry.register_spec(spec())
    registry.set_enabled("demo", True)

    result = call(registry, "demo__echo", "not json")

    assert result.is_error
    assert "JSON object" in result.content


def test_a_tool_error_reaches_the_model_verbatim(registry):
    async def failing(context, args):
        raise ToolError("the upstream said no")

    registry.register_spec(spec(tools=[tool(handler=failing)]))
    registry.set_enabled("demo", True)

    result = call(registry, "demo__echo")

    assert result.is_error
    assert "the upstream said no" in result.content


def test_an_unexpected_exception_never_leaks_its_text(registry, capsys):
    """Config carries secrets and exception strings quote the offending value.

    The transcript is stored in the browser and replayed to the engine every
    following turn, so one leak would be durable and repeated.
    """

    async def failing(context, args):
        raise RuntimeError("token sk-abc123 was rejected")

    registry.register_spec(spec(tools=[tool(handler=failing)]))
    registry.set_enabled("demo", True)

    result = call(registry, "demo__echo")

    assert result.is_error
    assert "sk-abc123" not in result.content
    assert "unexpected error" in result.content
    assert "sk-abc123" in capsys.readouterr().err


def test_cancellation_propagates(registry):
    """Swallowing it would break client-disconnect propagation."""

    async def cancelled(context, args):
        raise asyncio.CancelledError

    registry.register_spec(spec(tools=[tool(handler=cancelled)]))
    registry.set_enabled("demo", True)

    with pytest.raises(asyncio.CancelledError):
        call(registry, "demo__echo")


def test_a_hanging_handler_is_bounded(registry, monkeypatch):
    """MAX_TOOL_EXECUTIONS bounds the COUNT of calls, not the duration of one."""
    monkeypatch.setattr("rmlx_web.plugins.DEFAULT_TIMEOUT", 0.05)

    async def forever(context, args):
        await asyncio.sleep(30)

    registry.register_spec(spec(tools=[tool(handler=forever)]))
    registry.set_enabled("demo", True)

    result = call(registry, "demo__echo")

    assert result.is_error
    assert "did not answer" in result.content


def test_a_non_text_return_is_reported(registry):
    async def wrong(context, args):
        return {"not": "text"}

    registry.register_spec(spec(tools=[tool(handler=wrong)]))
    registry.set_enabled("demo", True)

    result = call(registry, "demo__echo")

    assert result.is_error
    assert "not text" in result.content


def test_a_plugin_uninstalled_mid_turn_refuses_rather_than_raising(registry):
    """The page computed `advertised` before the restart that removed it."""
    result = call(registry, "gone__tool")

    assert result.is_error
    assert "no longer installed" in result.content
