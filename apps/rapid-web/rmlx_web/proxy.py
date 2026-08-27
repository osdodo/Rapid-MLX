# SPDX-License-Identifier: Apache-2.0
"""Streaming reverse proxy from the web surface to the engine.

Three things this layer has to get right, none of which are automatic:

1. **The engine's address is not fixed.** It is resolved per request
   from the supervisor, because a model switch replaces the child on a
   new port. Caching a base URL here would break every request after the
   first switch.

2. **The two bearer tokens are different secrets.** The token the phone
   presents is the *web* token; the engine has its own, handed to it via
   ``RAPID_MLX_API_KEY`` at spawn. The client's ``Authorization`` header
   is therefore dropped and replaced, never forwarded. Forwarding it
   would leak the web token to the engine's request log and would fail
   the engine's own auth besides.

3. **Client disconnects must reach the engine.** A phone that locks its
   screen or switches networks drops the connection silently. If that
   is not propagated, the engine keeps generating against a socket
   nobody is reading — burning GPU for a response that cannot be
   delivered. ``httpx``'s streaming context manager closes the upstream
   response when the generator is closed, which is what happens when
   Starlette abandons the body iterator.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator

import httpx

# No overall read timeout on the streaming leg. Time-to-first-token on a
# large model after a cold prefix-cache miss is genuinely long, and a
# timeout here would abort a generation that was progressing normally.
# Connect is bounded because a refused connection should surface fast.
_STREAM_TIMEOUT = httpx.Timeout(connect=10.0, read=None, write=60.0, pool=10.0)

# Headers that describe the *hop*, not the payload. Copying them from
# the engine's response onto ours corrupts the framing: the engine's
# Content-Length counts its bytes, not ours, and its Transfer-Encoding
# has already been undone by httpx.
_HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "content-length",
    "content-encoding",
}


def filtered_response_headers(headers: httpx.Headers) -> dict[str, str]:
    return {k: v for k, v in headers.items() if k.lower() not in _HOP_BY_HOP}


def upstream_headers(api_key: str, *, accept: str | None = None) -> dict[str, str]:
    """Headers for the request we make to the engine."""
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    if accept:
        headers["Accept"] = accept
    return headers


def is_streaming_request(payload: dict) -> bool:
    return bool(payload.get("stream"))


async def proxy_streaming(
    client: httpx.AsyncClient,
    *,
    base_url: str,
    path: str,
    payload: dict,
    api_key: str,
) -> AsyncIterator[bytes]:
    """Relay a streaming completion, chunk by chunk.

    Yields raw bytes rather than parsed SSE events: the engine already
    emits well-formed ``data:`` frames and the browser's
    ``EventSource``-style reader wants them verbatim. Re-serialising
    would risk changing the framing for no benefit.

    Errors are converted into a terminal SSE frame instead of being
    raised, because by the time the first byte has been written the
    response status is already committed — raising would just truncate
    the stream and leave the page waiting forever.
    """
    url = f"{base_url.rstrip('/')}{path}"
    try:
        async with client.stream(
            "POST",
            url,
            json=payload,
            headers=upstream_headers(api_key, accept="text/event-stream"),
            timeout=_STREAM_TIMEOUT,
        ) as response:
            if response.status_code >= 400:
                # Read the whole error body before touching it: on the
                # error path the engine sends a normal JSON document,
                # not a stream, and aiter_raw would hand back fragments.
                body = await response.aread()
                yield _error_frame(_describe_upstream_error(response.status_code, body))
                return

            async for chunk in response.aiter_raw():
                if chunk:
                    yield chunk
    except httpx.HTTPError as exc:
        yield _error_frame(f"connection to the engine failed: {exc}")


async def proxy_unary(
    client: httpx.AsyncClient,
    *,
    base_url: str,
    path: str,
    payload: dict,
    api_key: str,
) -> httpx.Response:
    """Relay a non-streaming completion.

    Kept separate from the streaming path rather than unified behind a
    flag: the two differ in status handling (this one can still choose
    its status code, the streaming one cannot) and in timeout policy.
    """
    url = f"{base_url.rstrip('/')}{path}"
    return await client.post(
        url,
        json=payload,
        headers=upstream_headers(api_key),
        timeout=_STREAM_TIMEOUT,
    )


def _describe_upstream_error(status_code: int, body: bytes) -> str:
    """Turn the engine's error body into one line for the page.

    The engine's shape is ``{"error": {"message": ...}}``; older or
    partial responses may be anything at all, so the raw text is the
    fallback rather than an exception.
    """
    text = body.decode("utf-8", errors="replace").strip()
    try:
        parsed = json.loads(text)
    except (ValueError, TypeError):
        return f"engine returned {status_code}: {text[:400]}"

    if isinstance(parsed, dict):
        error = parsed.get("error")
        if isinstance(error, dict) and error.get("message"):
            return f"engine returned {status_code}: {error['message']}"
        if isinstance(error, str):
            return f"engine returned {status_code}: {error}"
    return f"engine returned {status_code}: {text[:400]}"


def _error_frame(message: str) -> bytes:
    """A terminal SSE frame the page can render as a failed turn.

    Shaped like the engine's own error envelope so the frontend has one
    error path rather than two.
    """
    payload = json.dumps({"error": {"message": message, "type": "proxy_error"}})
    return f"data: {payload}\n\ndata: [DONE]\n\n".encode()
