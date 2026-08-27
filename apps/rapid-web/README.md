# rmlx-web

Chat with a Rapid-MLX model from your phone, while the model keeps running
on your Mac.

This is a standalone command. It does not require the Rapid-MLX Desktop app,
and it does not modify it. See [PLAN.md](PLAN.md) for the design and for the
reasoning behind the decisions below.

Status: **M5** — the page is a React application (`frontend/`); see
[The page](#the-page).

## Install

```sh
pip install rapid-mlx                 # the engine, if you do not have it
pip install -e 'apps/rapid-web[qr]'   # this package
```

The `[qr]` extra prints a scannable QR code at startup so you do not have to
type a 43-character token on a phone. Plain `pip install -e apps/rapid-web`
works too; it prints the same link as text.

If you installed this before the rename, run `pip uninstall rapid-mlx-web`
first. The distribution is now `rmlx-web` and the command is `rmlx-web`
(matching the engine's short `rmlx`); pip treats the old name as a separate
package, so both `rapid-mlx-web` and `rmlx-web` would otherwise stay on PATH
pointing at different checkouts. Saved conversations and tokens are
unaffected — the browser's storage keys deliberately did not change.

## Use

```sh
rmlx-web qwen3.5-4b-4bit
```

It prints a URL and an access token:

```
  rmlx-web
  URL:   http://127.0.0.1:7788/
  Token: 1A_h7Z7Z-x1cARbeh4yGthsVl4x2SMRo0cWCcxIWDLw
```

On a loopback bind there is **no token** — open the URL and start typing. The
OS already guarantees the caller is a process on this Mac, so a token there
would only mean copying a 43-character string to reach your own machine.

Bind to anything else (`--host 0.0.0.0`, or any tunnel) and a token becomes
mandatory. It travels in the URL **fragment**, which browsers never send to a
server, so it cannot end up in an access log or a tunnel provider's request
history; the page stores it and strips it from the address bar. Scan the QR
code and you are signed in, or paste the token by hand.

You can force a token on loopback too — `--token` or `--new-token` — which is
worth doing when screen-sharing.

The page is reachable immediately; the model loads in the background and the
header says when it is ready. A cold start can take several minutes.

Assistant replies render markdown — headings, lists, GFM tables, block quotes,
links, LaTeX, and syntax-highlighted code blocks with a copy button. Reasoning
models stream their scratchpad into a collapsed **Thinking** panel above the
answer. Each turn is followed by its throughput, token count and
time-to-first-token.

Hover or tap a message for its actions: **Copy**, **Retry** (re-answer that
prompt), **Edit** (change what you asked and send it again) and **Delete**.
Retrying or editing keeps the previous version — a `‹ 2/3 ›` control appears on
answers that have alternatives, so nothing is lost by asking again. Deleting
says how many turns go with it, including any on branches you cannot currently
see.

The header button row is **Chats**, **New** (fresh conversation, without
erasing the current one) and **Settings** (system prompt, sampling, appearance,
maths rendering; stored per browser). The send button becomes a stop control
while a reply streams, and stopping keeps whatever already arrived. Scrolling
up during a reply stops the view from following it, and a button appears to
return to the bottom.

**Chats** lists conversations grouped by day, with search over both titles and
message bodies, and per-row pin, archive, rename and delete.

When the model is not ready, a band above the composer says so in one place —
what is wrong, and the single action that fixes it (Download, Start, Retry,
Reconnect). Sending is refused until the model is actually serving, and a
refused send keeps your draft rather than swallowing it.

Tap the model name in the header to switch models. Downloaded models are
tagged; picking one that is not downloaded yet starts a download with a live
progress bar you can cancel.

Only chat models are listed. Image, video and audio aliases have no chat
endpoint, so offering them would mean waiting out a large download for
something that fails on the first message.

## Reaching it from a phone

`rmlx-web` binds loopback and **does not ship a tunnel**. Point your own
at it:

```sh
cloudflared tunnel --url http://127.0.0.1:7788
# or
tailscale funnel 7788
```

Then open the tunnel's URL on the phone and enter the same token.

If you would rather not use a tunnel and only need LAN access, `--host
0.0.0.0` works — but read the warning it prints. On a cafe, hotel or office
guest network the LAN is effectively public, and the token is then the only
thing protecting the port.

## Options

| flag | meaning |
|---|---|
| `--host` | Bind address. Default `127.0.0.1`. |
| `--port` | Default `7788`. |
| `--attach URL` | Use a `rapid-mlx serve` you started yourself instead of spawning one. |
| `--attach-api-key` | Bearer for the `--attach` target, if it has one. |
| `--token` | Use a specific access token instead of the stored one. |
| `--new-token` | Rotate the stored token. Phones must re-enter it. |
| `--allow-downloads` | Permit downloads when bound to a non-loopback address. |
| `--rapid-mlx-bin` | Path to `rapid-mlx`, if it is not on `PATH`. |
| `--serve-arg` | Extra argument passed through to `rapid-mlx serve`. Repeat per token. |

## How it works

```
phone ── your tunnel ──> rmlx-web :7788 ──> rapid-mlx serve :<ephemeral>
```

`rmlx-web` spawns and owns the engine process. That indirection is what
lets the external port stay fixed: switching models means restarting the
engine on a new port, so a page pointed straight at the engine would break on
every switch.

Switching is refused with a 409 while a chat response is still streaming.
Restarting the engine mid-generation would destroy that answer — most likely
for the person sitting at the Mac, who has no idea the phone is there.

It drives the `rapid-mlx` command as a subprocess and never imports
`vllm_mlx`, so it stays installable and testable without the engine. The
model list comes from `rapid-mlx models --json` and `--cached --json`; the
alias list is read once per process, and the disk scan is re-read on a short
TTL (the Refresh button forces it).

### `--attach` cannot target the Desktop app

The Desktop app generates a fresh bearer for its engine on every launch and
passes it via the environment
(`apps/rapid-mac/Sources/Rapid/Server/BearerSecret.swift`). No other process
can obtain it. `--attach` works against a `rapid-mlx serve` you started
yourself.

## Security

Attaching a tunnel puts this on the public internet, so:

- **A token is required whenever the port is not loopback.** There is no flag
  to turn that off. It is stored at `~/.rapid-mlx/web-token` with mode 0600 and
  persists across restarts, so the phone is not logged out each time you
  restart the command. On loopback the bearer is skipped, but nothing else is:
  the checks below still apply, and they are what stops a web page you have
  open from driving this port through your browser — a page can reach a
  loopback port even though it cannot reach the network the port is on.
- **The web token and the engine's token are different secrets.** The proxy
  strips the client's `Authorization` header and substitutes the engine's, so
  the web token never reaches the engine or its logs.
- **Cross-origin requests are refused** via `Origin` / `Sec-Fetch-Site`, and
  request bodies must be `application/json`. Without these, any page you have
  open on the Mac could drive this port through your browser.
- **Model names are validated against the catalog** before they reach a
  subprocess argument. Accepting an arbitrary `org/repo` would turn the model
  picker into a general-purpose remote fetch.
- **Downloads are gated.** Enabled on loopback, but off by default once the
  port is on a network — `--allow-downloads` is required there, because a
  download is the one operation here that consumes an unbounded amount of
  someone else's disk. Every pull is also checked against free space (with
  10 GiB of headroom), and a model whose size is *unknown* is refused rather
  than guessed at. Only one download runs at a time.

## Limitations

- Conversations are stored in the browser's `localStorage` only. A chat
  started on the phone does **not** appear in the Desktop app's sidebar; the
  app's history file is written by a single-writer queue and a second process
  writing it would race. The 30 most recent conversations are kept (pinned ones
  are never dropped first), 200 messages on the visible branch each —
  `localStorage` is about 5 MB per origin and throws on overflow, so dropping
  the oldest is better than silently failing to save anything.
- **Upgrading from 0.1 rewrites the stored history and older builds cannot
  read it.** Branching needs a message tree, which the previous flat format
  cannot represent. The migration runs once, automatically, and keeps every
  message — but if you then open the same browser against an older build, its
  conversation list will look empty. Nothing has been deleted; the newer format
  is simply unreadable to it. Downgrade and it stays that way, so export
  anything you cannot lose first.
- Text chat only. No images, audio, tools or MCP.
- Downloads are one at a time, and progress is lost from the page if you
  reload mid-download — the download itself continues, and reopening the
  model sheet reconnects to it.
- `--attach` mode cannot list or switch models: listing needs the `rapid-mlx`
  CLI and switching needs ownership of the engine process, and an attached
  server has neither.
- One user. There is one token and no sessions.

## Tests

```sh
cd apps/rapid-web
pip install -e '.[test]'
pytest
```

The tests use a stub engine, so they run without MLX, a model, or a
`rapid-mlx` install.

## The page

The page is a React application in `frontend/`. It is built to a **single**
`rmlx_web/static/index.html` with every script and stylesheet inlined, and
that artifact is committed.

That is not a packaging preference. `app.py` mounts no `/static` route and the
CSP is `default-src 'self'`, so a build that emitted a second file would have
nowhere to serve it from and the page would render blank. The size gate fails
the build if more than one file is emitted, and a pytest asserts the same thing
from the Python side.

**Never hand-edit `rmlx_web/static/index.html`** — it is generated, and
the next build silently discards the change.

```sh
cd apps/rapid-web/frontend
pnpm install --frozen-lockfile
pnpm run test        # Vitest: markdown safety, readiness, migration, SSE framing
pnpm run build       # writes ../rmlx_web/static/index.html, with the size gate
pnpm run e2e         # Playwright, against the built page and a stub engine
```

**pnpm, not npm.** `.npmrc` sets `engine-strict` against an unsatisfiable
`engines.npm`, so `npm install` fails with `EBADENGINE` rather than quietly
writing a second lockfile. The reason is the artifact gate above: CI rebuilds
`index.html` and diffs it against the committed copy, which only holds if
every machine resolves the same dependency tree. Two lockfiles disagreeing is
how that turns into a failure on a PR that never touched the frontend.

For development against a live backend, run `rmlx-web` in one terminal and
`pnpm run dev` in another. The dev server **must** proxy `/api` and `/v1`, which
`vite.config.ts` already does: the server admits a browser request only when it
is same-origin, so a page served from :5173 talking directly to :7788 is
refused on every request with `403 origin_refused`.

Bundle size is a product constraint here, not housekeeping: `GET /` re-reads
and re-sends the whole page on every request with no caching, over a tunnel, to
a phone that reloads whenever iOS evicts the tab. `frontend/size-budget.json`
records the measured size and the dependency costs behind it.
