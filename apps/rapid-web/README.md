# rmlx-web

Chat with a Rapid-MLX model from your phone, while the model keeps running
on your Mac.

A standalone command. It does not require the Rapid-MLX Desktop app, and it
does not modify it.

## Run it locally

```sh
cd apps/rapid-web
pip install rapid-mlx       # the engine, if you do not have it
pip install -e '.[test]'    # this package
rmlx-web                    # serves http://127.0.0.1:7788/
pytest                      # stub engine — no MLX, model or rapid-mlx needed
```

The page is a React application in `frontend/`, built to `rmlx_web/static/`
as a small shell plus content-hashed assets. **The build output is committed**
and CI diffs it against a fresh build, so never hand-edit it.

```sh
cd apps/rapid-web/frontend
pnpm install --frozen-lockfile
pnpm run test        # Vitest
pnpm run build       # writes ../rmlx_web/static/
pnpm run e2e         # Playwright, against the built page and a stub engine
```

**pnpm, not npm.** `.npmrc` sets `engine-strict` against an unsatisfiable
`engines.npm`, so `npm install` fails rather than quietly writing a second
lockfile — which would break the artifact diff above.

For development against a live backend, run `rmlx-web` in one terminal and
`pnpm run dev` in another. The dev server must proxy `/api` and `/v1`
(`vite.config.ts` does): the server admits browser requests only when
same-origin, so :5173 talking directly to :7788 gets `403 origin_refused`.

`frontend/size-budget.json` records the measured bundle size. Assets are
content-hashed and served immutable, so they cross the wire once per build.

## Use

```sh
rmlx-web [alias]
```

It prints a URL:

```
  rmlx-web
  URL:   http://127.0.0.1:7788/
  Token: <generated access token>
```

The alias is optional — without it the page starts with no model and you pick
one there. The page is reachable immediately; a cold start can take several
minutes and the header says when the model is ready.

An access token is generated and stored at `~/.rapid-mlx/web-token` on the
first launch, then reused. `--token` supplies an explicit token and
`--new-token` rotates the stored one. The token travels in the URL fragment of
the printed sign-in link, which browsers never send to a server, so it cannot
land in an access log or a tunnel provider's history.

### The page

Replies render markdown — tables, LaTeX, syntax-highlighted code with a copy
button — and reasoning models stream their scratchpad into a collapsed
**Thinking** panel. Each turn reports throughput, token count and
time-to-first-token.

Hover or tap a message for **Copy**, **Retry**, **Edit** and **Delete**.
Retrying or editing keeps the previous version behind a `‹ 2/3 ›` control, so
nothing is lost by asking again.

The header has **Chats** (grouped by day, searchable over titles and bodies,
with pin/archive/rename/delete), **New** and **Settings** (system prompt,
sampling, appearance; stored per browser). Tap the model name to switch
models, download one that is not cached yet, or delete one to free its disk.

When the model is not ready, a band above the composer says what is wrong and
offers the single action that fixes it. A refused send keeps your draft.

Only chat models are listed — image, video and audio aliases have no chat
endpoint, so offering them would mean waiting out a large download for
something that fails on the first message.

## Reaching it from a phone

`rmlx-web` binds loopback and **does not ship a tunnel**. Point your own at it:

```sh
cloudflared tunnel --url http://127.0.0.1:7788
# or
tailscale funnel 7788
```

Keep the tunnel's own access control in front of it — Cloudflare Access or a
tailnet ACL — as defence in depth around the built-in token.

`--host 0.0.0.0` works for LAN-only access, but on a cafe, hotel or office
guest network the LAN is effectively public. The token remains required, but a
tunnel or firewall boundary is still preferable to a bare network port.

## Options

| flag | meaning |
|---|---|
| `--host` | Bind address. Default `127.0.0.1`. |
| `--port` | Default `7788`. |
| `--attach URL` | Use a `rapid-mlx serve` you started yourself instead of spawning one. |
| `--attach-api-key` | Bearer for the `--attach` target, if it has one. |
| `--token` | Use this access token instead of the stored generated token. |
| `--new-token` | Rotate the stored token. Phones must re-enter it. |
| `--allow-downloads` | Permit downloads when bound to a non-loopback address. |
| `--rapid-mlx-bin` | Path to `rapid-mlx`, if it is not on `PATH`. |
| `--serve-arg` | Extra argument passed through to `rapid-mlx serve`. Repeat per token. |
| `--list-plugins` | List installed plugins with their load status, and exit. |

## Plugins

A plugin is an ordinary Python package that adds tools to this server. Unlike
an MCP connector — a separate program the engine spawns — a plugin runs inside
`rmlx-web` itself, which makes it the cheaper way to wire up something small
and local.

Install one into the interpreter that runs `rmlx-web`, restart, and turn it on
under **Settings → Tools**. `rmlx-web --list-plugins` prints what loaded, what
failed and the exact `pip` path to use — worth running first, because a
Homebrew install puts `rmlx-web` in a virtualenv your own `pip` is not.

```sh
$(brew --prefix rmlx-web)/libexec/bin/pip install rmlx-web-something
```

**Every plugin is off until you turn it on**, and a plugin that requires
settings offers nothing to the model until they are filled in.

### Writing one

`examples/demo-plugin/` is a working plugin exercising the whole surface —
tools, a per-tool approval requirement, settings including a secret, and an
HTTP route. Install it with `pip install -e apps/rapid-web/examples/demo-plugin`
to see it appear.

The whole contract is one entry point:

```toml
[project.entry-points."rmlx_web.plugins"]
myplugin = "my_plugin:register"
```

pointing at a zero-argument callable that returns a `PluginSpec`:

```python
from rmlx_web.plugins import ConfigField, PluginContext, PluginSpec, PluginTool

async def search(context: PluginContext, args: dict) -> str:
    response = await context.http.get(
        "https://example.internal/search",
        params={"q": args["query"]},
        headers={"Authorization": f"Bearer {context.config['api_token']}"},
    )
    return response.text

def register() -> PluginSpec:
    return PluginSpec(
        name="mine",
        title="My Search",
        description="Searches the internal index.",
        tools=[
            PluginTool(
                name="search",                       # advertised as mine__search
                title="Internal Search",             # what Settings calls it
                description="Search the internal index.",
                parameters={
                    "type": "object",
                    "properties": {"query": {"type": "string"}},
                    "required": ["query"],
                },
                handler=search,
                requires_approval=False,
            )
        ],
        config=[ConfigField(key="api_token", label="API token", kind="secret", required=True)],
    )
```

Things worth knowing before you write one:

- **Handlers must be `async`.** The same event loop streams every reply; one
  blocking call stalls generation in every open tab. Use `asyncio.to_thread`
  for libraries that cannot cooperate.
- **Use `context.http`**, the server's shared client. A per-call client loses
  connection reuse and leaks connections when a reply is abandoned.
- **Tool names are namespaced** to `plugin__tool`, so two plugins can both
  offer a `search`. The composite must fit 64 characters. `title` is what the
  settings screen shows; without one it uses the bare name. Keep `description`
  written for the model — it appears under a disclosure, not as a heading.
- **`raise ToolError("...")` to tell the model something it can act on.** Any
  other exception is reported generically and logged, because exception text
  routinely quotes the value that caused it — which may be your API token, and
  the transcript is kept and replayed on every following turn.
- **A secret is never sent to the browser**, not even masked. The settings
  screen reports only whether one is stored.
- **A `router=APIRouter()`** is mounted at `/api/plugins/<name>` and inherits
  the server's authentication; it refuses with 409 while the plugin is off.
- One tool with a malformed schema is dropped and the rest of the plugin still
  works — but a plugin that fails to import contributes nothing.

### What the switch does, and does not

Turning a plugin off stops its tools being offered and makes its routes refuse,
immediately. It does **not** stop its code running: naming a plugin's tools and
settings means importing it, so every *installed* plugin is imported at startup
whatever the switch says. **`pip install` is the trust decision**; the switch is
a capability decision. Install plugins you wrote or read.

Installing or removing a plugin needs a restart to take effect. Switches and
settings do not.

## How it works

```
phone ── your tunnel ──> rmlx-web :7788 ──> rapid-mlx serve :<ephemeral>
```

`rmlx-web` spawns and owns the engine. That indirection keeps the external
port fixed: switching models restarts the engine on a new port, so a page
pointed straight at the engine would break on every switch. Switching is
refused with a 409 while a response is streaming, since restarting
mid-generation would destroy that answer.

It drives the `rapid-mlx` command as a subprocess and never imports
`vllm_mlx`, so it stays installable and testable without the engine.

`--attach` cannot target the Desktop app: that app generates a fresh bearer
for its engine on every launch and no other process can obtain it.

## Security

Attaching a tunnel puts this on the public internet, so:

- **Authentication is required by the server.** The generated token is stored
  at `~/.rapid-mlx/web-token`, mode 0600, and persists so the phone is not
  logged out on every restart. Tunnel access control remains useful defence in
  depth; it is not the server's only trust boundary.
- **The web token and the engine's token are different secrets.** The proxy
  strips the client's `Authorization` and substitutes the engine's, so the web
  token never reaches the engine or its logs.
- **Cross-origin requests are refused** via `Origin` / `Sec-Fetch-Site`.
  Mutations use `application/json`; image and audio uploads use Multipart plus
  a required non-simple header, which forces a cross-origin browser to
  preflight and be refused.
- **Uploads are bounded before parsing.** Image and audio files are limited to
  25 MiB, the whole Multipart request to 26 MiB, and an upload that stops
  delivering bytes for 15 seconds is terminated. Dictation automatically
  stops at 12 minutes before browser-side WAV transcoding can exhaust memory;
  imported images are capped at 20 megapixels for the same reason.
- **Browse destinations are IP-pinned after validation.** Every initial URL
  and redirect hop is resolved once, all answers must be public, and the
  socket connects only to those validated addresses while preserving the
  original HTTP Host and TLS identity. Environment proxies are disabled for
  this path so they cannot perform a second, unchecked resolution.
- **Model names are validated against the catalog** before reaching a
  subprocess argument. An arbitrary `org/repo` would otherwise turn the picker
  into a remote fetch — or, for deletion, a remote delete. Removal passes the
  catalog's own repository id, never the caller's string.
- **Downloads are gated**: on by default on loopback, off once the port is on
  a network unless `--allow-downloads` says otherwise. Every pull is checked
  against free space (10 GiB headroom) and a model of unknown size is refused
  rather than guessed at. One download at a time.
- **Deleting a model is not behind that flag** — it frees disk rather than
  consuming it — but it is destructive, and anyone who can reach the page can
  do it.

## Limitations

- Conversations live in the browser's `localStorage` only, so a chat started
  on the phone does not appear in the Desktop app. 30 conversations are kept
  (pinned never dropped first), 200 messages on the visible branch each.
- **Upgrading from 0.1 rewrites the stored history and older builds cannot
  read it.** Branching needs a message tree the previous flat format cannot
  represent. The migration keeps every message, but downgrading afterwards
  shows an empty list — export anything you cannot lose first.
- Three built-in tools — `weather`, `web_search`, `browse` — plus MCP
  connectors and plugins configured from Settings. They run on the Mac, not in
  the browser, because a page cannot fetch a cross-origin provider. `browse`
  asks before each new host: the model chooses the URL, so approving it is what
  stops a page fetch becoming a way to post the conversation elsewhere. Its
  server-side IP checks also block private, loopback and link-local targets.
  At most 3 calls answer one message.
- Plugins run in this process with no sandbox, and are imported at startup
  whether or not they are switched on. `brew upgrade rmlx-web` rebuilds the
  virtualenv and removes every installed plugin; reinstall them afterwards.
- Downloads are one at a time, with progress polled once a second, so
  reloading mid-download reconnects to the running pull.
- `--attach` mode cannot list or switch models: listing needs the CLI and
  switching needs ownership of the engine process.
- One user. No sessions, and at most one token.

## Install

```sh
brew install rapidmlx/tap/rmlx-web
```

The formula depends on `rapid-mlx`, so Homebrew pulls the engine in as well —
there is no Python environment to manage.

From a checkout instead:

```sh
pip install rapid-mlx                 # the engine, if you do not have it
pip install -e apps/rapid-web         # this package
```

If you installed this before the rename, `pip uninstall rapid-mlx-web` first —
pip treats the old name as a separate package, so both commands would stay on
PATH pointing at different checkouts. Saved conversations and tokens are
unaffected.
