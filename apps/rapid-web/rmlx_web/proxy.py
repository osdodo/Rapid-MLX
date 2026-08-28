# SPDX-License-Identifier: Apache-2.0
"""Streaming reverse proxy from the web surface to the engine.

Three constraints, none automatic:

1. The engine's address is resolved per request from the supervisor — a
   model switch replaces the child on a new port, so a cached base URL
   breaks every request after the first switch.
2. The phone's bearer and the engine's are **different secrets**. The
   client's ``Authorization`` is dropped and replaced, never forwarded.
3. Client disconnects must reach the engine, or it keeps generating
   against a socket nobody reads. ``httpx``'s streaming context manager
   closes upstream when the generator is closed, which is what Starlette
   does when it abandons the body iterator.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator

import httpx

# No read timeout on the streaming leg: time-to-first-token after a cold
# prefix-cache miss is genuinely long. Connect stays bounded so a refused
# connection surfaces fast.
_STREAM_TIMEOUT = httpx.Timeout(connect=10.0, read=None, write=60.0, pool=10.0)

# Headers describing the hop, not the payload. Copying them from the
# engine's response corrupts our framing.
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

    Yields raw bytes rather than parsed SSE events — the engine already
    emits well-formed ``data:`` frames. Errors become a terminal SSE frame
    rather than an exception: once the first byte is written the status is
    committed, so raising would truncate the stream and leave the page
    waiting forever.
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
                # Read the whole body first: on the error path the engine
                # sends a JSON document, not a stream, and aiter_raw would
                # hand back fragments.
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

    Separate from the streaming path rather than unified behind a flag:
    the two differ in status handling (this one can still choose its
    status code) and in timeout policy.
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

    The engine's shape is ``{"error": {"message": ...}}``; anything else
    falls back to raw text rather than raising.
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
    """A terminal SSE frame shaped like the engine's error envelope, so the
    frontend has one error path rather than two."""
    payload = json.dumps({"error": {"message": message, "type": "proxy_error"}})
    return f"data: {payload}\n\ndata: [DONE]\n\n".encode()
