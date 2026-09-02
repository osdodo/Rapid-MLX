# SPDX-License-Identifier: Apache-2.0
"""User-installed plugins: tools, config and routes contributed by pip packages.

A plugin is an ordinary distribution declaring an entry point::

    [project.entry-points."rmlx_web.plugins"]
    jira = "rmlx_web_jira:register"

whose value resolves to a zero-argument callable returning a :class:`PluginSpec`.

Zero arguments is deliberate. ``register(app)`` would hand a plugin mutable
server state at import time — the one moment the host cannot defend — and
nothing needs it: everything a handler wants at call time arrives in a
:class:`PluginContext`. It also makes discovery a pure function of ``sys.path``,
which is what lets the registry be tested without a running app.

**Disabled does not mean not executed.** The spec is the only thing that names a
plugin's tools, schemas, config and router, and the only way to obtain it is to
import the module and call ``register()``. There is no metadata-only path. So
import-time side effects run for every INSTALLED plugin at startup regardless of
the switch; the switch governs capability, and ``pip install`` is the trust
decision. Anything worded as though the switch were a sandbox boundary is wrong.
"""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import json
import re
import sys
import traceback
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from importlib.metadata import entry_points
from pathlib import Path
from typing import Any, Literal

import httpx

from .connectors import _write_private
from .tools import ToolError, ToolResult, normalize_arguments

ENTRY_POINT_GROUP = "rmlx_web.plugins"

# Shorter than a connector's 32: the composite has to fit the 64-character
# OpenAI function-name budget alongside a real tool name, and a plugin author
# gets no "the UI rejected it" feedback loop while writing the package.
MAX_NAME_LENGTH = 24
_NAME_RE = re.compile(r"^[A-Za-z0-9_-]+$")
_CONFIG_KEY_RE = re.compile(r"^[A-Za-z0-9_]+$")
FUNCTION_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# ``/api/plugins/<name>`` collides with the management routes for these three.
# Registration order already decides the winner, but a plugin whose routes are
# unreachable for a reason invisible in its own source is worth refusing.
RESERVED_NAMES = frozenset({"settings", "state", "call"})

# Nothing else bounds a handler. ``MAX_TOOL_EXECUTIONS`` in the page bounds the
# COUNT of calls in a turn, not the duration of one.
DEFAULT_TIMEOUT = 30.0

ConfigKind = Literal["string", "secret", "number", "boolean", "enum"]
_CONFIG_KINDS = ("string", "secret", "number", "boolean", "enum")


def is_legal_function_name(name: str) -> bool:
    """Whether a namespaced ``owner__tool`` can travel as a function name.

    Advertising one the model cannot emit — or that 400s on the wire — reads as
    "that tool silently does nothing".
    """
    return bool(FUNCTION_NAME_RE.match(name))


# ------------------------------------------------------------------ the spec


@dataclass(frozen=True)
class PluginContext:
    """What a handler is given for one call."""

    # ``app.state.http``. A per-call client loses connection reuse and leaks
    # connections when a streaming response is abandoned (app.py's lifespan
    # says so); passing the shared one in makes the correct path the easy one.
    http: httpx.AsyncClient
    # This plugin's resolved config, secrets included. Read per call rather
    # than captured at import, so an edit in Settings takes effect at once.
    config: Mapping[str, Any]
    plugin: str


Handler = Callable[[PluginContext, dict], Awaitable[Any]]


@dataclass(frozen=True)
class ConfigField:
    """One settings field, rendered generically by the page."""

    key: str
    label: str
    kind: ConfigKind = "string"
    required: bool = False
    default: Any = None
    help: str = ""
    # (value, label) pairs. ``enum`` only.
    choices: Sequence[tuple[str, str]] = ()
    placeholder: str = ""


@dataclass(frozen=True)
class PluginTool:
    """One tool. ``name`` is BARE — the host owns the namespace."""

    name: str
    description: str
    parameters: dict
    handler: Handler
    requires_approval: bool = False
    # What the settings screen calls this tool. `description` is written for
    # the MODEL — it carries calling conventions and pagination offsets — so
    # presenting it as a setting reads as documentation rather than a switch.
    # Empty falls back to the bare name, which is at least true.
    title: str = ""


@dataclass(frozen=True)
class PluginSpec:
    """What ``register()`` returns."""

    name: str
    title: str
    description: str = ""
    tools: Sequence[PluginTool] = ()
    config: Sequence[ConfigField] = ()
    # Mounted under ``/api/plugins/<name>``. Typed loosely so this module does
    # not import fastapi for a field most plugins leave None.
    router: Any = None


@dataclass
class LoadedPlugin:
    """A spec that survived validation, plus what the host derived from it."""

    spec: PluginSpec
    version: str = ""
    # Bare name -> tool, for the tools that survived. A tool dropped for an
    # illegal composite or a bad schema is absent here but its plugin lives on.
    tools: dict[str, PluginTool] = field(default_factory=dict)

    def full_name(self, bare: str) -> str:
        return f"{self.spec.name}__{bare}"


@dataclass(frozen=True)
class PluginLoadError:
    """Something a user has to fix, named by whatever it could be attributed to."""

    name: str
    message: str


# ------------------------------------------------------------- registration


def spec_error(spec: Any, taken: set[str]) -> str | None:
    """Why ``spec`` cannot be registered, or None."""
    if not isinstance(spec, PluginSpec):
        return "register() did not return a PluginSpec"
    name = spec.name
    if not isinstance(name, str) or not name:
        return "the plugin has no name"
    if len(name) > MAX_NAME_LENGTH:
        return f"the name is longer than {MAX_NAME_LENGTH} characters"
    # Both sides split the composite on the FIRST separator, so `my__plugin`
    # would dispatch to a plugin called `my` and never resolve.
    if "__" in name:
        return "the name cannot contain '__'"
    if not _NAME_RE.match(name):
        return "the name must be letters, numbers, dashes or underscores"
    if name in RESERVED_NAMES:
        return f"'{name}' is reserved by rmlx-web"
    if name in taken:
        return f"another plugin is already registered as '{name}'"
    if not isinstance(spec.title, str) or not spec.title:
        return "the plugin has no title"
    return None


def tool_error(tool: Any, owner: str, taken: set[str]) -> str | None:
    """Why one tool cannot be advertised, or None.

    A rejected tool is dropped on its own. Refusing the whole plugin because
    one of its tools is malformed would take working capability away over a
    fault the user cannot see.

    The message never names the tool: every caller already prefixes it, and a
    name repeated twice in one line is unreadable exactly when the name is the
    problem.
    """
    if not isinstance(tool, PluginTool):
        return "is not a PluginTool"
    if not isinstance(tool.name, str) or not _NAME_RE.match(tool.name or ""):
        return "has an unusable name"
    full = f"{owner}__{tool.name}"
    if not is_legal_function_name(full):
        return (
            f"has a name that cannot travel as a function name — "
            f"'{owner}__' plus the tool name must be at most 64 characters"
        )
    if full in taken:
        return "has a name that is already taken by another tool"
    if not isinstance(tool.description, str) or not tool.description:
        return "has no description"
    # A non-string title would reach the settings screen and be rendered.
    # Empty is fine — it falls back to the bare name.
    if not isinstance(tool.title, str):
        return "has a title that is not text"
    # The engine rejects the whole `tools` array if one entry is malformed, so
    # a bad schema here would silently disable EVERY tool in the conversation.
    if not isinstance(tool.parameters, dict) or tool.parameters.get("type") != "object":
        return "has parameters that are not a JSON Schema object"
    # The same event loop carries SSE relay and image jobs. One blocking call
    # in a handler stalls every in-flight generation in every open tab.
    if not inspect.iscoroutinefunction(tool.handler):
        return "has a handler that is not an async function"
    return None


def _config_error(fields: Sequence[Any]) -> str | None:
    seen: set[str] = set()
    for entry in fields:
        if not isinstance(entry, ConfigField):
            return "a config entry is not a ConfigField"
        if not isinstance(entry.key, str) or not _CONFIG_KEY_RE.match(entry.key or ""):
            return f"config key {entry.key!r} must be letters, numbers or underscores"
        if entry.key in seen:
            return f"config key '{entry.key}' is declared twice"
        seen.add(entry.key)
        if entry.kind not in _CONFIG_KINDS:
            return f"config key '{entry.key}' has an unknown kind '{entry.kind}'"
        if entry.kind == "enum" and not entry.choices:
            return f"config key '{entry.key}' is an enum with no choices"
    return None


# ---------------------------------------------------------------- the store


def default_settings_path() -> Path:
    """Beside the connector settings, in a file this module alone writes.

    NOT ``rmlx-web.json``: ``ConnectorStore._write_settings`` merges a patch
    into its CACHED document and rewrites the whole file without re-reading,
    so two writers would silently delete each other's keys — here that would
    mean a connector toggle erasing saved plugin secrets.
    """
    return Path.home() / ".config" / "rapid-mlx" / "rmlx-web-plugins.json"


class PluginRegistry:
    """Discovered plugins, their switches, and their config.

    Discovery is NOT run by the constructor. ``ConnectorStore`` gets away with
    reading its file eagerly because ``tests/conftest.py`` repoints ``HOME``;
    that does nothing for ``entry_points()``, which reads ``sys.path``. An
    eager default factory would make every test load whatever the developer
    happens to have installed.
    """

    def __init__(self, *, settings_path: Path | None = None) -> None:
        self._settings_path = settings_path or default_settings_path()
        self._loaded: dict[str, LoadedPlugin] = {}
        self._load_errors: list[PluginLoadError] = []
        self._settings = self._read_settings()

    # -- discovery

    def discover(self) -> None:
        """Import every installed plugin and register what validates."""
        try:
            found = list(entry_points(group=ENTRY_POINT_GROUP))
        except Exception as exc:  # pragma: no cover - importlib internals
            self._load_errors.append(PluginLoadError("", f"discovery failed: {exc}"))
            return
        # Sorted so a duplicate name resolves the same way on every machine:
        # otherwise the filesystem, not the config, decides which one runs.
        for entry in sorted(found, key=lambda e: (e.name, e.value)):
            self._load_entry_point(entry)
        self._reconcile_grants()

    def register_spec(self, spec: PluginSpec, *, version: str = "") -> None:
        """Register an already-constructed spec. The test seam, and the

        implementation discovery delegates to once a module has been imported.
        """
        problem = spec_error(spec, set(self._loaded))
        if problem is not None:
            name = spec.name if isinstance(getattr(spec, "name", None), str) else ""
            self._load_errors.append(PluginLoadError(name, problem))
            return

        problem = _config_error(spec.config)
        if problem is not None:
            self._load_errors.append(PluginLoadError(spec.name, problem))
            return

        loaded = LoadedPlugin(spec=spec, version=version)
        # Composites only. A built-in name can never collide: every composite
        # contains `__`, which `is_valid_name` refuses in a plugin name and no
        # built-in has. The page still resolves plugin-vs-connector collisions,
        # which cannot be seen from here — the engine's tool list is fetched
        # per request.
        taken = self.tool_names()
        for tool in spec.tools:
            problem = tool_error(tool, spec.name, taken)
            if problem is not None:
                self._load_errors.append(
                    PluginLoadError(
                        spec.name,
                        f"tool '{_label(getattr(tool, 'name', None))}' {problem}",
                    )
                )
                continue
            loaded.tools[tool.name] = tool
            taken.add(loaded.full_name(tool.name))

        if spec.router is not None and not _is_router(spec.router):
            self._load_errors.append(
                PluginLoadError(spec.name, "router is not a fastapi APIRouter")
            )
            loaded = LoadedPlugin(
                spec=PluginSpec(
                    name=spec.name,
                    title=spec.title,
                    description=spec.description,
                    tools=spec.tools,
                    config=spec.config,
                    router=None,
                ),
                version=version,
                tools=loaded.tools,
            )

        self._loaded[spec.name] = loaded

    def _load_entry_point(self, entry) -> None:
        try:
            register = entry.load()
        # SystemExit is a BaseException and `sys.exit()` in a module body is a
        # real pattern (vllm_mlx/cli.py does it on a cache miss), so a bare
        # `except Exception` would let one plugin kill the server. Not
        # BaseException wholesale: KeyboardInterrupt has to keep working.
        except (Exception, SystemExit) as exc:
            self._load_errors.append(
                PluginLoadError(entry.name, f"failed to import: {exc}")
            )
            return

        if not callable(register):
            self._load_errors.append(
                PluginLoadError(entry.name, "the entry point is not callable")
            )
            return

        try:
            spec = register()
        except (Exception, SystemExit) as exc:
            self._load_errors.append(
                PluginLoadError(entry.name, f"register() raised: {exc}")
            )
            return

        version = ""
        with contextlib.suppress(Exception):
            version = entry.dist.version if entry.dist is not None else ""
        self.register_spec(spec, version=version)

    # -- read surface

    @property
    def loaded(self) -> list[LoadedPlugin]:
        return [self._loaded[name] for name in sorted(self._loaded)]

    @property
    def load_errors(self) -> list[PluginLoadError]:
        return list(self._load_errors)

    def tool_names(self) -> set[str]:
        return {
            plugin.full_name(bare)
            for plugin in self._loaded.values()
            for bare in plugin.tools
        }

    def owns(self, name: str) -> bool:
        """Whether ``name`` is a plugin tool, enabled or not.

        Ignores the switches on purpose: a call to a switched-off tool has to
        reach the plugin refusal, which names the switch, rather than the
        built-in path's "unknown tool".
        """
        return name in self.tool_names()

    def is_enabled(self, name: str) -> bool:
        entry = self._plugin_settings(name)
        return entry.get("enabled") is True

    def disabled_tools(self) -> set[str]:
        out: set[str] = set()
        for name, plugin in self._loaded.items():
            stored = self._plugin_settings(name).get("disabledTools")
            if not isinstance(stored, list):
                continue
            for bare in plugin.tools:
                if plugin.full_name(bare) in stored or bare in stored:
                    out.add(plugin.full_name(bare))
        return out

    def granted_tools(self) -> set[str]:
        stored = self._settings.get("grantedTools")
        if not isinstance(stored, list):
            return set()
        return {item for item in stored if isinstance(item, str)}

    def config_for(self, name: str) -> dict:
        """Resolved config: declared defaults overlaid with stored values."""
        plugin = self._loaded.get(name)
        if plugin is None:
            return {}
        stored = self._plugin_settings(name).get("config")
        stored = stored if isinstance(stored, dict) else {}
        resolved: dict[str, Any] = {}
        for entry in plugin.spec.config:
            if entry.key in stored:
                resolved[entry.key] = stored[entry.key]
            elif entry.default is not None:
                resolved[entry.key] = entry.default
        return resolved

    def missing_config(self, name: str) -> list[ConfigField]:
        plugin = self._loaded.get(name)
        if plugin is None:
            return []
        resolved = self.config_for(name)
        return [
            entry
            for entry in plugin.spec.config
            if entry.required and _is_blank(resolved.get(entry.key))
        ]

    def definitions(self) -> list[dict]:
        """OpenAI tool definitions for every enabled, non-disabled tool."""
        disabled = self.disabled_tools()
        out: list[dict] = []
        for plugin in self.loaded:
            if not self.is_enabled(plugin.spec.name):
                continue
            for bare, tool in sorted(plugin.tools.items()):
                full = plugin.full_name(bare)
                if full in disabled:
                    continue
                out.append(
                    {
                        "type": "function",
                        "function": {
                            "name": full,
                            "description": tool.description,
                            "parameters": tool.parameters,
                        },
                    }
                )
        return out

    def approval_required(self) -> set[str]:
        return {
            plugin.full_name(bare)
            for plugin in self._loaded.values()
            for bare, tool in plugin.tools.items()
            if tool.requires_approval
        }

    def snapshot(self) -> dict:
        """Everything the settings panel renders, in one read."""
        disabled = self.disabled_tools()
        granted = self.granted_tools()
        plugins = []
        for plugin in self.loaded:
            name = plugin.spec.name
            resolved = self.config_for(name)
            plugins.append(
                {
                    "name": name,
                    "title": plugin.spec.title,
                    "description": plugin.spec.description,
                    "version": plugin.version,
                    "enabled": self.is_enabled(name),
                    "config_complete": not self.missing_config(name),
                    "has_router": plugin.spec.router is not None,
                    "tools": [
                        {
                            "name": plugin.full_name(bare),
                            "short": bare,
                            # Resolved here rather than in the page, so an
                            # absent title has one fallback rather than one
                            # per place that renders a tool.
                            "title": tool.title or bare,
                            "description": tool.description,
                            "parameters": tool.parameters,
                            "requires_approval": tool.requires_approval,
                            "enabled": plugin.full_name(bare) not in disabled,
                        }
                        for bare, tool in sorted(plugin.tools.items())
                    ],
                    "config": [
                        _field_view(entry, resolved) for entry in plugin.spec.config
                    ],
                }
            )
        return {
            "plugins": plugins,
            "load_errors": [
                {"name": err.name, "message": err.message} for err in self._load_errors
            ],
            "granted_tools": sorted(granted),
            "disabled_tools": sorted(disabled),
        }

    # -- write surface

    def set_enabled(self, name: str, enabled: bool) -> None:
        self._require(name)
        self._patch_plugin(name, {"enabled": bool(enabled)})

    def set_tool_enabled(self, full_name: str, enabled: bool) -> None:
        owner = self._owner_of(full_name)
        stored = self._plugin_settings(owner).get("disabledTools")
        current = (
            {item for item in stored if isinstance(item, str)}
            if isinstance(stored, list)
            else set()
        )
        if enabled:
            current.discard(full_name)
        else:
            current.add(full_name)
        self._patch_plugin(owner, {"disabledTools": sorted(current)})

    def grant_tool(self, full_name: str) -> None:
        self._owner_of(full_name)
        self._write_settings(
            {"grantedTools": sorted(self.granted_tools() | {full_name})}
        )

    def reset_grants(self) -> None:
        self._write_settings({"grantedTools": []})

    def set_config(self, name: str, values: Mapping[str, Any]) -> None:
        """Apply a validated config patch.

        A ``secret`` key that is absent means "leave unchanged" and an empty
        string means "clear" — the panel only sends a secret the user actually
        typed, because the snapshot never gives it one to echo back.
        """
        plugin = self._require(name)
        declared = {entry.key: entry for entry in plugin.spec.config}
        stored = self._plugin_settings(name).get("config")
        merged = dict(stored) if isinstance(stored, dict) else {}
        for key, raw in values.items():
            entry = declared.get(key)
            if entry is None:
                raise PluginError(f"'{name}' has no setting called '{key}'")
            if entry.kind == "secret" and raw == "":
                merged.pop(key, None)
                continue
            merged[key] = _coerce(entry, raw)
        self._patch_plugin(name, {"config": merged})

    # -- internals

    def _require(self, name: str) -> LoadedPlugin:
        plugin = self._loaded.get(name)
        if plugin is None:
            raise PluginError(f"No plugin named '{name}'.")
        return plugin

    def _owner_of(self, full_name: str) -> str:
        owner = full_name.split("__", 1)[0]
        if full_name not in self.tool_names():
            raise PluginError(f"No plugin tool named '{full_name}'.")
        return owner

    def _plugin_settings(self, name: str) -> dict:
        plugins = self._settings.get("plugins")
        if not isinstance(plugins, dict):
            return {}
        entry = plugins.get(name)
        return entry if isinstance(entry, dict) else {}

    def _patch_plugin(self, name: str, patch: dict) -> None:
        plugins = self._settings.get("plugins")
        plugins = dict(plugins) if isinstance(plugins, dict) else {}
        plugins[name] = {**self._plugin_settings(name), **patch}
        self._write_settings({"plugins": plugins})

    def _reconcile_grants(self) -> None:
        """Drop grants for a plugin whose installed version changed.

        An upgraded package runs different code than the one consent was given
        to — the same argument ``ConnectorStore`` makes for an execution
        fingerprint, with the distribution version standing in for it.
        """
        stored = self._settings.get("versions")
        stored = stored if isinstance(stored, dict) else {}
        current = {p.spec.name: p.version for p in self._loaded.values()}
        granted = self.granted_tools()
        for name, version in current.items():
            previous = stored.get(name)
            if isinstance(previous, str) and previous != version:
                granted = {t for t in granted if not t.startswith(f"{name}__")}
        self._write_settings({"versions": current, "grantedTools": sorted(granted)})

    def _read_settings(self) -> dict:
        try:
            data = json.loads(self._settings_path.read_text())
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def _write_settings(self, patch: dict) -> None:
        merged = {**self._settings, **patch}
        try:
            _write_private(
                self._settings_path, json.dumps(merged, indent=2, sort_keys=True)
            )
        except OSError as exc:
            raise PluginError(f"Couldn't save {self._settings_path}: {exc}") from exc
        self._settings = merged


class PluginError(ValueError):
    """A plugin operation cannot be completed. The message is shown verbatim."""


# ---------------------------------------------------------------- dispatch


async def run_plugin_tool(
    registry: PluginRegistry,
    client: httpx.AsyncClient,
    *,
    name: str,
    arguments: str,
    advertised: set[str],
) -> ToolResult:
    """Execute one plugin tool, having first checked it may run.

    The ``advertised`` check is repeated here rather than left to the route for
    the reason ``tools.run_tool`` repeats it: omitting a tool from the request
    body does not stop a malformed model emitting a call for it, and a second
    copy of the gate in the route is the copy that drifts.
    """
    if name not in advertised:
        listed = ", ".join(sorted(advertised))
        suffix = f" — available: {listed}" if listed else ""
        return ToolResult(
            f"unknown tool '{name}'{suffix}. Answer directly instead.", is_error=True
        )

    owner, _, bare = name.partition("__")
    plugin = next((p for p in registry.loaded if p.spec.name == owner), None)
    if plugin is None or bare not in plugin.tools:
        return ToolResult(
            f"tool '{name}' is no longer installed. Answer directly instead.",
            is_error=True,
        )

    # Refusals are ToolResults, not HTTP errors: the MODEL reads them and can
    # recover, and the check stays on the same side of the boundary as the
    # tool list that produced the name.
    if not registry.is_enabled(owner):
        return ToolResult(
            f"tool '{name}' isn't available — the '{plugin.spec.title}' plugin is "
            "turned off in Settings → Tools.",
            is_error=True,
        )
    if name in registry.disabled_tools():
        return ToolResult(
            f"tool '{name}' is switched off in Settings → Tools.", is_error=True
        )

    # Never call a handler with a required field missing: the KeyError it then
    # raises names a dict key, which the user cannot act on.
    missing = registry.missing_config(owner)
    if missing:
        labels = ", ".join(entry.label for entry in missing)
        return ToolResult(
            f"tool '{name}' is not configured — set {labels} in Settings → Tools.",
            is_error=True,
        )

    tool = plugin.tools[bare]
    definition = {"function": {"parameters": tool.parameters}}
    args = normalize_arguments(arguments, definition)
    if args is None:
        return ToolResult(
            f"tool '{name}' error: arguments must be a JSON object matching the "
            "advertised schema",
            is_error=True,
        )

    context = PluginContext(
        http=client, config=registry.config_for(owner), plugin=owner
    )
    try:
        result = await asyncio.wait_for(
            tool.handler(context, args), timeout=DEFAULT_TIMEOUT
        )
    except asyncio.CancelledError:
        # Swallowing this breaks client-disconnect propagation.
        raise
    except asyncio.TimeoutError:
        return ToolResult(
            f"{name} error: the plugin did not answer within {DEFAULT_TIMEOUT:.0f}s",
            is_error=True,
        )
    except ToolError as exc:
        return ToolResult(f"{name} error: {exc}", is_error=True)
    except httpx.HTTPError as exc:
        return ToolResult(f"{name} error: {exc}", is_error=True)
    except Exception:
        # NOT str(exc). A plugin's config carries secrets, and the commonest
        # Python exception string quotes the value that caused it — which would
        # then be persisted to localStorage and replayed to the engine on every
        # following turn. The traceback goes where only the operator sees it.
        traceback.print_exc(file=sys.stderr)
        return ToolResult(
            f"{name} error: the plugin raised an unexpected error "
            "(see the rmlx-web log)",
            is_error=True,
        )

    if isinstance(result, ToolResult):
        # `needs_approval` is the browse redirect re-prompt protocol, tied to
        # origin semantics only run_browse produces. Letting a plugin emit one
        # would put an arbitrary string into a dialog the user reads as a
        # security prompt.
        return ToolResult(result.content, is_error=result.is_error)
    if isinstance(result, str):
        return ToolResult(result)
    return ToolResult(
        f"{name} error: the plugin returned {type(result).__name__}, not text",
        is_error=True,
    )


# ------------------------------------------------------------------ helpers


def _label(name: Any) -> str:
    """A tool name safe to put in a one-line error.

    An over-long name is itself a rejection reason, so the message that
    reports it is exactly the one that would otherwise be flooded by it.
    """
    if not isinstance(name, str) or not name:
        return "?"
    return name if len(name) <= 32 else f"{name[:32]}…"


def _is_router(candidate: Any) -> bool:
    try:
        from fastapi import APIRouter
    except ImportError:  # pragma: no cover - fastapi is a hard dependency
        return False
    return isinstance(candidate, APIRouter)


def _is_blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and value.strip() == "")


def _field_view(entry: ConfigField, resolved: Mapping[str, Any]) -> dict:
    """One config field as the page sees it.

    A secret serialises as ``has_value`` with NO ``value`` key — not a masked
    string. Returning "sk-••••" invites the form to round-trip it, and then the
    mask becomes the stored value the first time someone forgets to strip it.
    """
    view: dict[str, Any] = {
        "key": entry.key,
        "label": entry.label,
        "kind": entry.kind,
        "required": entry.required,
        "help": entry.help,
        "placeholder": entry.placeholder,
    }
    if entry.kind == "enum":
        view["choices"] = [
            {"value": value, "label": label} for value, label in entry.choices
        ]
    if entry.kind == "secret":
        view["has_value"] = not _is_blank(resolved.get(entry.key))
    else:
        view["value"] = resolved.get(entry.key, entry.default)
    return view


def _coerce(entry: ConfigField, raw: Any) -> Any:
    """Validate one submitted value against its declared kind.

    Not the browser's job: the same body is reachable with curl plus the
    bearer, and these values are handed to code that runs locally.
    """
    if entry.kind in ("string", "secret"):
        if not isinstance(raw, str):
            raise PluginError(f"'{entry.label}' must be text")
        return raw
    if entry.kind == "number":
        # bool is an int subclass, so it has to be excluded explicitly.
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            raise PluginError(f"'{entry.label}' must be a number")
        value = float(raw)
        if value != value or value in (float("inf"), float("-inf")):
            raise PluginError(f"'{entry.label}' must be a finite number")
        return value
    if entry.kind == "boolean":
        if not isinstance(raw, bool):
            raise PluginError(f"'{entry.label}' must be true or false")
        return raw
    allowed = {value for value, _ in entry.choices}
    if raw not in allowed:
        raise PluginError(
            f"'{entry.label}' must be one of: {', '.join(sorted(allowed))}"
        )
    return raw
