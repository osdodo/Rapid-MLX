# SPDX-License-Identifier: Apache-2.0
"""``rmlx-web`` entry point."""

from __future__ import annotations

import argparse
import io
import ipaddress
import socket
import sys
from urllib.parse import quote

import uvicorn

from . import __version__, auth
from .app import WebConfig, create_app
from .catalog import ModelCatalog
from .downloads import DownloadManager
from .supervisor import (
    AttachedEngine,
    EngineSupervisor,
    SupervisorError,
    find_rapid_mlx_binary,
)

DEFAULT_PORT = 7788


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="rmlx-web",
        description=(
            "Serve a mobile-friendly web UI for Rapid-MLX. Point your own "
            "tunnel (cloudflared / tailscale funnel / frp) at it to reach it "
            "from a phone."
        ),
    )
    parser.add_argument(
        "model",
        nargs="?",
        help=("Model alias to load (e.g. qwen3.5-4b-4bit). Omit only with --attach."),
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help=(
            "Address to bind. Defaults to 127.0.0.1. Every tunnel connects to "
            "a local port, so loopback covers the remote-access case; "
            "0.0.0.0 additionally exposes this to everyone on the current "
            "network, which on a cafe or hotel network is effectively public."
        ),
    )
    parser.add_argument(
        "--port", type=int, default=DEFAULT_PORT, help=f"Port (default {DEFAULT_PORT})."
    )
    parser.add_argument(
        "--attach",
        metavar="URL",
        help=(
            "Use an already-running `rapid-mlx serve` instead of starting one. "
            "Model switching is unavailable in this mode. This cannot attach "
            "to the Rapid-MLX Desktop app's engine: that bearer is generated "
            "per launch and is not obtainable by another process."
        ),
    )
    parser.add_argument(
        "--attach-api-key",
        metavar="KEY",
        help="Bearer for the --attach target, if it was started with one.",
    )
    parser.add_argument(
        "--token",
        metavar="TOKEN",
        help=(
            "Access token for the web UI. Defaults to a persistent token at "
            "~/.rapid-mlx/web-token, created on first run."
        ),
    )
    parser.add_argument(
        "--new-token",
        action="store_true",
        help="Rotate the stored access token. Existing phones must re-enter it.",
    )
    parser.add_argument(
        "--allow-downloads",
        action="store_true",
        help=(
            "Permit starting model downloads from the web UI when not bound "
            "to loopback. Downloads are already enabled on loopback; this "
            "flag only lifts the restriction that applies once the port is "
            "reachable from the network."
        ),
    )
    parser.add_argument(
        "--rapid-mlx-bin",
        metavar="PATH",
        help="Path to the `rapid-mlx` command, if it is not on PATH.",
    )
    parser.add_argument(
        "--serve-arg",
        action="append",
        default=[],
        metavar="ARG",
        help=(
            "Extra argument forwarded verbatim to `rapid-mlx serve`. Repeat "
            "for each token, e.g. --serve-arg --max-model-len --serve-arg 8192."
        ),
    )
    parser.add_argument("--version", action="version", version=__version__)
    return parser


def _is_loopback(host: str) -> bool:
    """Whether binding ``host`` keeps the surface off the network.

    Not a string comparison against "127.0.0.1": the entire 127/8 block
    is loopback, and "localhost" may resolve to ::1. Getting this wrong
    in the permissive direction would silently skip the exposure
    warning, so unparseable names are treated as non-loopback.
    """
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _display_host(host: str) -> str:
    """Host to print in the banner.

    A wildcard bind is not a reachable address, so echoing "0.0.0.0" back
    at the user produces a URL that does not work. Substitute the LAN
    address they most likely want.
    """
    if host not in ("0.0.0.0", "::"):
        return host
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            # No packet is sent; connect() on UDP only selects a route,
            # which is enough to learn which local address would be used.
            probe.connect(("192.0.2.1", 9))
            return probe.getsockname()[0]
    except OSError:
        return "localhost"


def _login_url(host: str, port: int, token: str | None) -> str:
    """URL that logs the browser in without retyping the token.

    The token goes in the **fragment**, not the query string. A fragment
    is never sent to the server, so it cannot land in an access log, a
    proxy log, or a tunnel provider's request history — all of which a
    query parameter would reach. The page reads it, stores it, and
    strips it from the address bar.

    It is still visible in the URL itself, so it belongs in a QR code
    or a copy-paste, not somewhere it will be shoulder-surfed.
    """
    base = f"http://{_display_host(host)}:{port}/"
    if token is None:
        return base
    return f"{base}#token={quote(token, safe='')}"


def _render_qr(url: str) -> str | None:
    """ASCII QR for ``url``, or ``None`` if unavailable.

    ``segno`` is an optional extra rather than a dependency: it exists
    only to save typing a token on a phone, and hand-rolling a QR
    encoder (Reed-Solomon, masking, version selection) is a great deal
    of code for a convenience. Without it the URL is still printed.
    """
    try:
        import segno
    except ImportError:
        return None

    try:
        buffer = io.StringIO()
        # border=1 rather than the spec's 4: a terminal QR still scans
        # reliably with a thinner quiet zone, and 4 rows of blank above
        # and below pushes the banner off a short window.
        segno.make(url, error="l").terminal(out=buffer, border=1)
        return buffer.getvalue()
    except Exception:
        # A QR is decoration. Never let it stop the server starting.
        return None


def _print_banner(*, host: str, port: int, token: str | None, loopback: bool) -> None:
    url = f"http://{_display_host(host)}:{port}/"
    login_url = _login_url(host, port, token)

    print()
    print("  rmlx-web")
    print(f"  URL:   {url}")
    if token is not None:
        print(f"  Token: {token}")
    else:
        print("  Auth:  none (loopback only)")
    print()

    qr = _render_qr(login_url)
    if qr:
        print("  Scan to open:" if token is None else "  Scan to open and sign in:")
        print(qr)
    else:
        if token is not None:
            print("  Open this link to sign in automatically:")
            print(f"  {login_url}")
            print()
        print("  (pip install 'rmlx-web[qr]' to show a scannable QR code)")
        print()

    if not loopback:
        print(
            "  WARNING: bound to a non-loopback address. Anyone on this "
            "network can reach this port."
        )
        print("  The access token is the only thing protecting it.")
        print()
    # Flush explicitly: stdout is block-buffered whenever it is not a TTY,
    # so under `rmlx-web > log &` — a normal way to run this — the
    # token would not appear until the buffer happened to fill. The token
    # is the one thing the user cannot proceed without.
    sys.stdout.flush()


def _resolve_engine(args: argparse.Namespace, *, downloads_enabled: bool):
    if args.attach:
        if args.model:
            raise SystemExit(
                "error: pass a model or --attach, not both. --attach uses the "
                "model already loaded by the running server."
            )
        # No catalog: listing aliases needs the `rapid-mlx` CLI, and an
        # attached engine may be the only rapid-mlx on this machine (a
        # remote host, a container). Switching is impossible here anyway,
        # so a list the user cannot act on would only mislead.
        return AttachedEngine(args.attach, api_key=args.attach_api_key), None, None

    if not args.model:
        raise SystemExit(
            "error: a model alias is required (e.g. `rmlx-web "
            "qwen3.5-4b-4bit`), or use --attach to reuse a running server."
        )

    binary = find_rapid_mlx_binary(args.rapid_mlx_bin)
    engine = EngineSupervisor(
        binary=binary,
        # The engine's bearer is NOT the web token. Keeping them separate
        # means a leaked web token cannot be replayed against the engine
        # directly, and the web token never reaches the engine's logs.
        api_key=auth.generate_token(),
        serve_args=list(args.serve_arg),
    )
    downloads = DownloadManager(binary) if downloads_enabled else None
    return engine, ModelCatalog(binary), downloads


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    loopback = _is_loopback(args.host)

    # Downloads default ON for loopback and OFF otherwise. The asymmetry
    # is the point: on loopback the only caller is the person at this
    # Mac, but once the port is on a network a download is an endpoint a
    # stranger can use to fill someone else's disk. Off the loopback the
    # user has to say so explicitly.
    downloads_enabled = loopback or args.allow_downloads
    if not loopback and args.allow_downloads:
        print(
            "  NOTE: downloads are enabled on a non-loopback address. "
            "Anyone with the token can fill this Mac's disk.\n",
            file=sys.stderr,
        )

    # No bearer on a loopback bind: the OS already guarantees the caller
    # is a process on this Mac, so a token there only makes the user copy
    # a 43-character string to reach their own machine. It is NOT skipped
    # once the port is on a network — that is exactly when it is the only
    # thing protecting inference, model switching and downloads.
    #
    # An explicit --token or --new-token opts back in on loopback too, so
    # there is still a way to have one when sharing a screen.
    needs_token = (not loopback) or bool(args.token) or args.new_token

    token: str | None = None
    if needs_token:
        try:
            token = auth.load_or_create_token(
                override=args.token,
                rotate=args.new_token,
            )
        except OSError as exc:
            print(
                f"error: could not read or create the token file: {exc}",
                file=sys.stderr,
            )
            return 1

    try:
        engine, catalog, downloads = _resolve_engine(
            args, downloads_enabled=downloads_enabled
        )
    except SupervisorError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    config = WebConfig(
        token=token,
        engine=engine,
        initial_model=args.model if not args.attach else None,
        catalog=catalog,
        downloads=downloads,
    )
    app = create_app(config)

    _print_banner(host=args.host, port=args.port, token=token, loopback=loopback)
    if config.initial_model:
        # The engine loads in the background once uvicorn's loop is up, so
        # the page is reachable immediately and reports "loading" rather
        # than refusing connections for the several minutes a cold start
        # can take.
        print(f"  Loading {config.initial_model} in the background…")
        print("  The page is usable now; it will say when the model is ready.\n")
        sys.stdout.flush()

    try:
        uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
