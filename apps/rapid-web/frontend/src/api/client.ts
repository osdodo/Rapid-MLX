import { errorFromResponse } from './errors';

/**
 * The bearer for this session, or null when the server runs without auth.
 *
 * Module-level rather than a store field because the SSE readers and the chat
 * proxy call ``api()`` from outside React, and threading a token through every
 * one of them buys nothing: there is exactly one token per page load.
 */
let token: string | null = null;

export function setToken(value: string | null): void {
  token = value;
}

export function getToken(): string | null {
  return token;
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  /** Serialised as JSON. A POST with no body still sends ``{}`` — see below. */
  body?: unknown;
  signal?: AbortSignal;
}

function headers(): HeadersInit {
  const base: Record<string, string> = {
    /**
     * Sent on EVERY request, including GETs.
     *
     * This is a CSRF control, not a parsing convenience (auth.py:188-200).
     * ``text/plain``, ``application/x-www-form-urlencoded`` and
     * ``multipart/form-data`` are the three CORS "simple" content types: a
     * cross-origin page can send them with no preflight, so the request lands
     * before the browser ever consults a CORS policy. ``application/json`` is
     * not on that list, so requiring it forces a preflight that the server
     * then fails. The server enforces it on POST/PUT/PATCH only (app.py:220-227),
     * but sending it everywhere keeps one code path.
     */
    'Content-Type': 'application/json',
  };
  if (token) base['Authorization'] = `Bearer ${token}`;
  return base;
}

/**
 * Fetch with the auth and content-type headers this server requires.
 *
 * Throws ``ApiError`` on any non-2xx, so callers deal with one failure shape.
 */
export async function request(path: string, options: RequestOptions = {}): Promise<Response> {
  const init: RequestInit = {
    method: options.method ?? 'GET',
    headers: headers(),
    // No cookies anywhere in this app; the bearer is the only credential.
    credentials: 'omit',
  };

  // Assigned conditionally rather than passed as `undefined`: under
  // exactOptionalPropertyTypes an explicit undefined is not the same as an
  // absent key, and `body: undefined` on a GET is a type error rather than a
  // no-op. `!== undefined` and not a truthiness check, because `{}` is
  // exactly the body /api/auth and /api/downloads/cancel send.
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  if (options.signal) init.signal = options.signal;

  const response = await fetch(path, init);

  if (!response.ok) throw await errorFromResponse(response);
  return response;
}

/** ``request`` plus JSON decoding, for the endpoints that return a document. */
export async function requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await request(path, options);
  return (await response.json()) as T;
}

/**
 * The one request that deliberately bypasses ``request``.
 *
 * ``GET /api/config`` runs before a token exists — it is what tells the page
 * whether to ask for one — so it must not send an ``Authorization`` header
 * and must not be routed through the shared error path that would clear a
 * token on 401.
 */
export async function requestPublic<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'omit',
  });
  if (!response.ok) throw await errorFromResponse(response);
  return (await response.json()) as T;
}
