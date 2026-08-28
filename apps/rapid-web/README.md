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
  Auth:  none
```

The alias is optional — without it the page starts with no model and you pick
one there. The page is reachable immediately; a cold start can take several
minutes and the header says when the model is ready.

There is **no access token by default**. Remote access here always goes
through a tunnel you chose, and that tunnel is where authentication belongs —
Cloudflare Access, a tailnet ACL, HTTP basic auth in front. A second secret
would only mean retyping 43 characters on a phone.

`--token` requires one anyway, which is worth doing when screen-sharing or on
an open LAN. `--new-token` generates and stores one at `~/.rapid-mlx/web-token`.
The token travels in the URL fragment of the printed sign-in link, which
browsers never send to a server, so it cannot land in an access log or a
tunnel provider's history.

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

Put the tunnel's own access control in front of it — Cloudflare Access, a
tailnet ACL — rather than exposing the URL and relying on nobody guessing it.

`--host 0.0.0.0` works for LAN-only access, but on a cafe, hotel or office
guest network the LAN is effectively public and nothing stands in front of the
port; pass `--token` there.

## Options

| flag | meaning |
|---|---|
| `--host` | Bind address. Default `127.0.0.1`. |
| `--port` | Default `7788`. |
| `--attach URL` | Use a `rapid-mlx serve` you started yourself instead of spawning one. |
| `--attach-api-key` | Bearer for the `--attach` target, if it has one. |
| `--token` | Require this access token. There is none by default. |
| `--new-token` | Require a token, generating and storing one. Phones must re-enter it. |
| `--allow-downloads` | Permit downloads when bound to a non-loopback address. |
| `--rapid-mlx-bin` | Path to `rapid-mlx`, if it is not on `PATH`. |
| `--serve-arg` | Extra argument passed through to `rapid-mlx serve`. Repeat per token. |

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

- **Authentication is the tunnel's job, not this tool's.** There is no token
  unless `--token` asks for one; when it does, it is stored at
  `~/.rapid-mlx/web-token`, mode 0600, and persistent so the phone is not
  logged out on every restart. Everything below applies either way — those
  checks are what stop a page you have open from driving this port through
  your browser, which it can do because a browser reaches loopback even when
  the network cannot.
- **The web token and the engine's token are different secrets.** The proxy
  strips the client's `Authorization` and substitutes the engine's, so the web
  token never reaches the engine or its logs.
- **Cross-origin requests are refused** via `Origin` / `Sec-Fetch-Site`, and
  bodies must be `application/json`.
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
- Three tools — `weather`, `web_search`, `browse` — and no MCP. They run on
  the Mac, not in the browser, because a page cannot fetch a cross-origin
  provider. `browse` asks before each new host: the model chooses the URL, so
  approving it is what stops a page fetch becoming a way to post the
  conversation elsewhere. At most 3 calls answer one message.
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
