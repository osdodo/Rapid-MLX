# SPDX-License-Identifier: Apache-2.0
"""Bearer token + browser-origin gating for the web surface.

Threat model, stated up front because it drives every choice here: the
moment the user attaches a tunnel this port is on the public internet.
The design must not assume "the tunnel will protect it".

Two independent gates:

1. **Bearer token** — stops anyone who does not have the secret. Always
   required; there is no opt-out flag, deliberately.
2. **Origin / fetch-metadata** — stops a *browser* the user already has
   open from being used as a confused deputy. This is the classic
   localhost-service hole: any page the user visits can ``fetch()`` a
   loopback port, and while it cannot read a cross-origin response
   without CORS, it can absolutely cause the side effect (start a
   multi-GB download, switch the loaded model). The bearer alone does
   not close this, since a malicious page could be told the token by a
   user who pasted it somewhere.
"""

from __future__ import annotations

import contextlib
import hmac
import os
import secrets
import stat
from pathlib import Path
from urllib.parse import urlsplit

DEFAULT_TOKEN_PATH = Path.home() / ".rapid-mlx" / "web-token"

# 32 bytes of urlsafe base64. Same order of magnitude as the desktop
# app's per-launch bearer (``BearerSecret.swift``, 32 raw bytes hex).
_TOKEN_BYTES = 32


def generate_token() -> str:
    """Fresh URL-safe secret.

    URL-safe rather than hex so it can be pasted into a query string or
    encoded in a QR code without escaping.
    """
    return secrets.token_urlsafe(_TOKEN_BYTES)


def load_or_create_token(
    path: Path | None = None,
    *,
    override: str | None = None,
    rotate: bool = False,
) -> str:
    """Resolve the bearer for this run.

    Unlike the desktop app, the token is **persisted** rather than
    rotated per launch. ``BearerSecret.swift`` can rotate freely because
    both parties are processes the app controls; here one party is a
    phone browser holding the token in ``localStorage``. Rotating on
    every start would silently log the user out each time the command is
    restarted, and the recovery path (go find the Mac, read the new
    token, retype it on the phone) defeats the point of remote access.

    Precedence: explicit ``override`` > existing file > freshly created.
    ``rotate`` forces a new secret even if the file exists.
    """
    if override:
        return override

    path = path or DEFAULT_TOKEN_PATH

    if not rotate and path.exists():
        existing = path.read_text(encoding="utf-8").strip()
        if existing:
            _harden_permissions(path)
            return existing

    token = generate_token()
    path.parent.mkdir(parents=True, exist_ok=True)
    # Create with 0600 from the start rather than writing then chmod'ing:
    # between those two steps the secret would be readable by every other
    # local user under a typical 022 umask.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, token.encode("utf-8"))
    finally:
        os.close(fd)
    _harden_permissions(path)
    return token


def _harden_permissions(path: Path) -> None:
    """Force 0600 on a token file that already existed.

    A file written by an older build, restored from a backup, or copied
    by hand can easily be 0644. Silently reading it would leave the
    secret world-readable for the whole session.
    """
    try:
        mode = stat.S_IMODE(path.stat().st_mode)
    except OSError:
        return
    if mode != 0o600:
        with contextlib.suppress(OSError):
            path.chmod(0o600)


def extract_bearer(authorization: str | None) -> str | None:
    """Pull the credential out of an ``Authorization`` header.

    Scheme match is case-insensitive per RFC 7235; the credential itself
    is not touched beyond stripping the single delimiting space.
    """
    if not authorization:
        return None
    scheme, _, credential = authorization.partition(" ")
    if scheme.lower() != "bearer":
        return None
    credential = credential.strip()
    return credential or None


def token_matches(expected: str, presented: str | None) -> bool:
    """Constant-time comparison.

    A plain ``==`` short-circuits on the first differing byte. Remote
    timing attacks across a tunnel are impractical, but the constant-time
    form costs nothing, so there is no reason to leave the question open.
    """
    if not presented:
        return False
    return hmac.compare_digest(expected, presented)


def _normalise_authority(value: str) -> str:
    """Reduce a host[:port] to a comparable form.

    Browsers omit the port from ``Origin`` when it is the scheme
    default, while ``Host`` may or may not carry it depending on the
    proxy in front. Dropping default ports makes the two comparable;
    everything else is compared verbatim.
    """
    value = value.strip().lower()
    if value.endswith(":80") or value.endswith(":443"):
        value = value.rsplit(":", 1)[0]
    return value


def origin_is_allowed(
    origin: str | None,
    host_header: str | None,
    sec_fetch_site: str | None,
) -> bool:
    """Decide whether a browser-originated request may proceed.

    Rules, in order:

    * No ``Origin`` at all -> allow. Non-browser clients (curl, a phone
      shortcut, a script) do not send one, and they are not the confused
      deputy this guard is about. A browser always sends ``Origin`` on
      cross-origin requests and on every non-GET.
    * ``Sec-Fetch-Site: same-origin`` / ``none`` -> allow, ``cross-site``
      / ``same-site`` -> deny. Chrome and Safari both send this, and it
      is the browser's own verdict, which cannot be forged by page JS.
    * Otherwise compare the ``Origin`` authority against ``Host``. Under
      a tunnel both carry the tunnel's hostname, so this holds without
      the user configuring an allow-list — which matters, because the
      whole point is that the external hostname is not known in advance.
    """
    if origin is None:
        return True

    if sec_fetch_site is not None:
        return sec_fetch_site.strip().lower() in ("same-origin", "none")

    if not host_header:
        return False

    origin_authority = _normalise_authority(urlsplit(origin).netloc)
    if not origin_authority:
        # "null" origin — sandboxed iframe, file:// page, or a redirect
        # that stripped it. Not something a legitimate client produces.
        return False

    return origin_authority == _normalise_authority(host_header)


def content_type_is_json(content_type: str | None) -> bool:
    """Require ``application/json`` on request bodies.

    This is a CSRF control, not a parsing convenience. ``text/plain``,
    ``application/x-www-form-urlencoded`` and ``multipart/form-data`` are
    the three CORS "simple" content types: a cross-origin page can send
    them with **no preflight**, so the request lands before the browser
    ever consults our CORS policy. ``application/json`` is not on that
    list, so requiring it forces a preflight that we then fail.
    """
    if not content_type:
        return False
    return content_type.split(";", 1)[0].strip().lower() == "application/json"
