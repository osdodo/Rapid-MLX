# SPDX-License-Identifier: Apache-2.0
"""A reference plugin, exercising every capability rmlx-web offers.

Install it into the interpreter that runs ``rmlx-web`` — ``rmlx-web
--list-plugins`` prints the right path — then restart the server and turn it
on under Settings → Tools.

All four contributions are here: tools, a per-tool approval requirement,
declared settings, and an HTTP router.
"""

from fastapi import APIRouter

from rmlx_web.plugins import (
    ConfigField,
    PluginContext,
    PluginSpec,
    PluginTool,
    ToolError,
)

# Mounted at /api/plugins/demo, and covered by rmlx-web's own guard: the
# bearer token, the origin check and the JSON content-type rule all apply
# without any work here. The route refuses with 409 while the plugin is off.
router = APIRouter()


@router.get("/ping")
async def ping() -> dict:
    return {"pong": True}


async def echo(context: PluginContext, args: dict) -> str:
    """Shows that declared settings reach the handler.

    ``args`` has already been parsed from the model's JSON and filtered to the
    keys this tool's schema declares, so anything the model invented is gone
    before it arrives.
    """
    prefix = context.config.get("prefix", "")
    return f"{prefix}{args['text']}"


async def whoami(context: PluginContext, args: dict) -> str:
    """Shows that a secret reaches the handler without reaching the browser.

    Raising ``ToolError`` puts the message in front of the model verbatim,
    which is right for a condition it can act on.
    """
    token = context.config.get("api_token")
    if not token:
        raise ToolError("no token configured")
    return f"authenticated with a {len(token)}-character token"


async def boom(context: PluginContext, args: dict) -> str:
    """Shows what an unexpected failure looks like.

    The message below is written to look like a leaked credential on purpose.
    An arbitrary exception's text NEVER reaches the model: the transcript is
    stored in the browser and replayed to the engine on every following turn,
    so one leak would be durable and repeated. The model sees a generic
    sentence; the traceback goes to the rmlx-web log.
    """
    raise RuntimeError("secret-value-sk-abc123 was rejected")


def register() -> PluginSpec:
    """The entry point: takes no arguments, returns a spec.

    Called once at startup for every INSTALLED plugin, including switched-off
    ones — the spec is the only thing that names a plugin's tools and
    settings, and obtaining it means importing this module. Import-time work
    therefore runs whatever the switch says, which is why ``pip install`` is
    the trust decision and the toggle is only a capability one.
    """
    return PluginSpec(
        name="demo",
        title="Demo",
        description="Proves the plugin surface end to end.",
        tools=[
            PluginTool(
                # A BARE name. The host namespaces it to `demo__echo`, so two
                # plugins can both offer an `echo` without colliding.
                name="echo",
                # What the settings screen calls it. Optional — without one
                # the bare name is used, which is true but seldom readable.
                title="Echo",
                # Written for the MODEL, not for the settings screen.
                description="Echo the text back, with the configured prefix.",
                parameters={
                    "type": "object",
                    "properties": {"text": {"type": "string"}},
                    "required": ["text"],
                },
                handler=echo,
            ),
            PluginTool(
                name="whoami",
                title="Who am I",
                description="Report the configured identity. Requires approval.",
                parameters={"type": "object", "properties": {}},
                handler=whoami,
                # The user confirms each call and may grant it permanently.
                # Worth setting for anything that writes, spends or discloses.
                requires_approval=True,
            ),
            PluginTool(
                name="boom",
                description="Always raises, to show how a failure is contained.",
                parameters={"type": "object", "properties": {}},
                handler=boom,
            ),
        ],
        config=[
            ConfigField(key="prefix", label="Prefix", placeholder=">> "),
            ConfigField(
                key="api_token",
                label="API token",
                # A password field that starts empty and is never sent back to
                # the page, not even masked.
                kind="secret",
                required=True,
                help="Any value will do; this plugin only measures its length.",
            ),
            ConfigField(
                key="mode",
                label="Mode",
                kind="enum",
                choices=[("fast", "Fast"), ("thorough", "Thorough")],
                default="fast",
            ),
        ],
        router=router,
    )
