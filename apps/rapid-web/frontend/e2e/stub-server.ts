// A stub Rapid-MLX server for the end-to-end suite.
//
// It serves the BUILT artifact, so the specs drive the real page rather than a
// dev bundle — the thing users get is the thing under test.
//
// Behaviour is driven by a scenario object supplied per test, because the
// interesting cases are all about how the page reacts to a server that is slow,
// busy, or failing. `node:http` only; adding a framework here would mean the
// harness has dependencies that can break independently of the app.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const STATIC_DIR = resolve(import.meta.dirname, '../../rmlx_web/static');

const ASSET_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

type EngineState = 'stopped' | 'starting' | 'ready' | 'failed';

export interface Scenario {
  authRequired: boolean;
  token: string;
  canSwitch: boolean;
  allowDownloads: boolean;
  engineState: EngineState;
  model: string | null;
  detail: string | null;
  models: Array<{
    alias: string;
    hf_path: string;
    size_bytes: number | null;
    cached: boolean;
    cached_bytes: number | null;
    tool_call_parser: string | null;
    reasoning_parser: string | null;
    is_text_only: boolean;
  }>;
  /** SSE frames for the next chat turn, sent in order. */
  chatFrames: string[] | null;
  /** Fail the next chat request with this status and error type. */
  chatFailure: { status: number; type: string; message: string } | null;
  /** Fail the next model load with this status and error type. */
  loadFailure: { status: number; type: string; message: string } | null;
  /** Delay between chat frames, so a spec can act mid-stream. */
  frameDelayMs: number;
}

const DEFAULT_SCENARIO: Scenario = {
  /** Require a bearer, as a non-loopback bind does. */
  authRequired: false,
  token: 'test-token',
  canSwitch: true,
  allowDownloads: true,
  engineState: 'ready',
  model: 'qwen3-4b',
  detail: null,
  models: [
    {
      alias: 'qwen3-4b',
      hf_path: 'org/qwen3-4b',
      size_bytes: 2_400_000_000,
      cached: true,
      cached_bytes: 2_400_000_000,
      tool_call_parser: null,
      reasoning_parser: null,
      is_text_only: true,
    },
    {
      alias: 'llama-8b',
      hf_path: 'org/llama-8b',
      size_bytes: 8_200_000_000,
      cached: false,
      cached_bytes: null,
      tool_call_parser: 'llama3',
      reasoning_parser: null,
      is_text_only: true,
    },
  ],
  chatFrames: null,
  chatFailure: null,
  loadFailure: null,
  frameDelayMs: 10,
};

function chatFrame(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

function usageFrame(tokens: number): string {
  return `data: ${JSON.stringify({ usage: { completion_tokens: tokens } })}\n\n`;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise<string>((resolveBody) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk));
    request.on('end', () => resolveBody(body));
  });
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

function apiError(response: ServerResponse, status: number, type: string, message: string): void {
  json(response, status, { error: { type, message } });
}

/**
 * Start the stub.
 *
 * Returns the base URL and a `scenario` object that a spec mutates between
 * requests, so a single page can be walked through several server states.
 */
export async function startStub(overrides: Partial<Scenario> = {}) {
  const scenario = { ...DEFAULT_SCENARIO, ...overrides };

  /**
   * Every socket this server has accepted.
   *
   * `server.close()` stops listening but WAITS for open connections, and this
   * stub deliberately holds the download feed open forever — mirroring
   * app.py:539-550. So a plain close hangs until the test times out, and the
   * failure surfaces as "Tearing down stub exceeded the test timeout" against
   * whichever test happened to be running, which points nowhere near the
   * cause. They are destroyed explicitly instead.
   */
  const sockets = new Set<import('node:net').Socket>();

  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;

    // The security headers the real server applies to everything, so a spec
    // could assert on them and so the page runs under the same CSP.
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
        "connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
    );

    if (path === '/') {
      const html = readFileSync(join(STATIC_DIR, 'index.html'), 'utf8');
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(html);
      return;
    }

    if (path.startsWith('/static/assets/')) {
      // normalize() then a prefix check: a `..` segment must not escape.
      const file = normalize(join(STATIC_DIR, path.slice('/static/'.length)));
      if (!file.startsWith(join(STATIC_DIR, 'assets'))) {
        response.writeHead(403).end();
        return;
      }
      let body: Buffer;
      try {
        body = readFileSync(file);
      } catch {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        'Content-Type': ASSET_TYPES[extname(file)] ?? 'application/octet-stream',
      });
      response.end(body);
      return;
    }

    if (path === '/api/config') {
      json(response, 200, { auth_required: scenario.authRequired });
      return;
    }

    // Everything below is behind the bearer, exactly as the real guard is.
    if (scenario.authRequired) {
      const presented = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (presented !== scenario.token) {
        apiError(response, 401, 'unauthorized', 'a valid token is required');
        return;
      }
    }

    if (path === '/api/auth') {
      json(response, 200, {
        ok: true,
        can_switch: scenario.canSwitch,
        allow_downloads: scenario.allowDownloads,
      });
      return;
    }

    if (path === '/api/status') {
      json(response, 200, {
        state: scenario.engineState,
        model: scenario.model,
        port: 8000,
        detail: scenario.detail,
        can_switch: scenario.canSwitch,
      });
      return;
    }

    if (path === '/api/models') {
      json(response, 200, {
        models: scenario.models,
        loaded: scenario.model,
        state: scenario.engineState,
        can_switch: scenario.canSwitch,
        allow_downloads: scenario.allowDownloads,
      });
      return;
    }

    if (path === '/api/models/load') {
      await readBody(request);
      if (scenario.loadFailure) {
        const { status, type, message } = scenario.loadFailure;
        apiError(response, status, type, message);
        return;
      }
      json(response, 200, { ok: true, model: scenario.model, state: 'ready' });
      return;
    }

    if (path === '/api/downloads/stream') {
      // Deliberately never closed, matching app.py:539-550.
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      });
      response.write(`data: ${JSON.stringify({ state: 'idle' })}\n\n`);
      return;
    }

    if (path === '/v1/chat/completions') {
      await readBody(request);

      if (scenario.chatFailure) {
        const { status, type, message } = scenario.chatFailure;
        apiError(response, status, type, message);
        return;
      }

      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      });

      const frames = scenario.chatFrames ?? [
        chatFrame('Hello'),
        chatFrame(' there.'),
        usageFrame(2),
      ];

      for (const frame of frames) {
        response.write(frame);
        await new Promise<void>((done) => setTimeout(done, scenario.frameDelayMs));
      }
      response.write('data: [DONE]\n\n');
      response.end();
      return;
    }

    response.writeHead(404).end();
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', () => ready()));
  const { port } = server.address() as AddressInfo;

  return {
    baseURL: `http://127.0.0.1:${port}`,
    scenario,
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

export { chatFrame, usageFrame };
