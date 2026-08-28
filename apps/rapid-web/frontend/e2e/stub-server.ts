// A stub Rapid-MLX server for the end-to-end suite.
//
// Serves the BUILT artifact, so the specs drive the real page. Behaviour comes
// from a per-test scenario object, since the interesting cases are all about
// how the page reacts to a slow, busy or failing server. `node:http` only, so
// the harness has no dependencies that can break independently of the app.

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
  /**
   * Every alias the engine is holding, including `model`. Null falls back to
   * just the primary. More than one models a hot load: a chat model and an
   * image model usable at the same time.
   */
  resident: string[] | null;
  detail: string | null;
  models: Array<{
    alias: string;
    hf_path: string;
    size_bytes: number | null;
    cached: boolean;
    kind: 'text' | 'image' | 'audio';
    loadable: boolean;
    cached_bytes: number | null;
    tool_call_parser: string | null;
    reasoning_parser: string | null;
    is_text_only: boolean;
    audio_kind: string | null;
    family: string | null;
    image_capability: 'generation' | 'editing' | 'both' | null;
  }>;
  /** SSE frames for the next chat turn, sent in order. */
  chatFrames: string[] | null;
  /** Fail the next chat request with this status and error type. */
  chatFailure: { status: number; type: string; message: string } | null;
  /** Fail the next model load with this status and error type. */
  loadFailure: { status: number; type: string; message: string } | null;
  /**
   * Answer a load with `ready` instead of `starting`.
   *
   * The real route answers `starting` and settles minutes later, so `false`
   * is the honest default. Specs that only care about what is serving
   * AFTERWARDS set this to skip the loading window.
   */
  loadSettlesReady: boolean;
  /** Fail the next model removal with this status and error type. */
  removeFailure: { status: number; type: string; message: string } | null;
  /** Aliases the stub has been asked to delete, in order. */
  removed: string[];
  /** What `/api/downloads/status` reports. Null means idle. */
  download: {
    state: 'running' | 'done' | 'failed' | 'cancelled';
    alias?: string;
    done_bytes?: number;
    total_bytes?: number | null;
    detail?: string | null;
  } | null;
  /** How many times `/api/downloads/status` has been requested. */
  statusPolls: number;
  /**
   * Delay `/api/status`, so a spec sees the window between choosing a model
   * and the first poll that describes it — which is exactly where "Start"
   * used to be offered for a model that was already starting.
   */
  statusDelayMs: number;
  /** Delay between chat frames, so a spec can act mid-stream. */
  frameDelayMs: number;
  /** Base64 PNG the next image render returns. Null renders nothing. */
  imageResult: string | null;
  /** What `/api/images/progress` reports. */
  imageProgress: { running: boolean; step: number; total: number };
  /** Delay before the image render answers, so a spec can act mid-render. */
  imageDelayMs: number;
  /** Every edit the stub has been asked for, in order. */
  edits: Array<{ prompt: string; model: string | null }>;
  /** Voices `/api/audio/voices` reports. Empty models a lane that has none. */
  voices: string[];
  /** Fail the next voices request with this status and error type. */
  voicesFailure: { status: number; type: string; message: string } | null;
  /** Text `/api/audio/transcriptions` returns. */
  transcript: string;
  /** What `/api/residency` reports. */
  residency: {
    memory_limit_bytes: number;
    memory_used_bytes: number;
    models: Array<{
      id: string;
      aliases: string[];
      state: string;
      pinned: boolean;
      estimated_bytes: number;
      measured_bytes: number | null;
    }>;
  };
}

const DEFAULT_SCENARIO: Scenario = {
  /** Require a bearer, as a non-loopback bind does. */
  authRequired: false,
  token: 'test-token',
  canSwitch: true,
  allowDownloads: true,
  engineState: 'ready',
  model: 'qwen3-4b',
  resident: null,
  detail: null,
  models: [
    {
      alias: 'qwen3-4b',
      hf_path: 'org/qwen3-4b',
      size_bytes: 2_400_000_000,
      cached: true,
      kind: 'text',
      loadable: true,
      cached_bytes: 2_400_000_000,
      tool_call_parser: null,
      reasoning_parser: null,
      is_text_only: true,
      audio_kind: null,
      family: null,
      image_capability: null,
    },
    {
      alias: 'llama-8b',
      hf_path: 'org/llama-8b',
      size_bytes: 8_200_000_000,
      cached: false,
      kind: 'text',
      loadable: true,
      cached_bytes: null,
      tool_call_parser: 'llama3',
      reasoning_parser: null,
      is_text_only: true,
      audio_kind: null,
      family: null,
      image_capability: null,
    },
    {
      alias: 'flux2-klein-4b',
      hf_path: 'org/flux2-klein-4b',
      size_bytes: 4_600_000_000,
      cached: true,
      kind: 'image',
      loadable: true,
      cached_bytes: 4_600_000_000,
      tool_call_parser: null,
      reasoning_parser: null,
      is_text_only: false,
      audio_kind: null,
      family: null,
      image_capability: 'both',
    },
    {
      alias: 'whisper-large-v3',
      hf_path: 'org/whisper-large-v3',
      size_bytes: null,
      cached: false,
      kind: 'audio',
      // `serve <audio-alias>` boots in audio mode, so audio IS loadable —
      // it is just the last resort, since the lane rides on whatever is
      // already serving.
      loadable: true,
      cached_bytes: null,
      tool_call_parser: null,
      reasoning_parser: null,
      is_text_only: false,
      audio_kind: 'stt',
      family: 'whisper',
      image_capability: null,
    },
    {
      alias: 'whisper-large-v3-turbo',
      hf_path: 'org/whisper-large-v3-turbo',
      size_bytes: null,
      cached: true,
      kind: 'audio',
      loadable: true,
      cached_bytes: 1_600_000_000,
      tool_call_parser: null,
      reasoning_parser: null,
      is_text_only: false,
      audio_kind: 'stt',
      family: 'whisper',
      image_capability: null,
    },
    {
      alias: 'kokoro',
      hf_path: 'org/Kokoro-82M-bf16',
      size_bytes: null,
      cached: true,
      kind: 'audio',
      loadable: true,
      cached_bytes: 330_000_000,
      tool_call_parser: null,
      reasoning_parser: null,
      is_text_only: false,
      audio_kind: 'tts',
      family: 'kokoro',
      image_capability: null,
    },
  ],
  chatFrames: null,
  chatFailure: null,
  loadFailure: null,
  loadSettlesReady: false,
  removeFailure: null,
  removed: [],
  download: null,
  statusPolls: 0,
  statusDelayMs: 0,
  frameDelayMs: 10,
  // A 1x1 transparent PNG: the specs assert the image is displayed and
  // saveable, not what it depicts.
  imageResult:
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  imageProgress: { running: false, step: 0, total: 0 },
  imageDelayMs: 0,
  edits: [],
  voices: ['af_heart', 'am_adam', 'bf_emma'],
  voicesFailure: null,
  transcript: 'this is a transcription',
  residency: {
    memory_limit_bytes: 25 * 1024 ** 3,
    memory_used_bytes: 9_750_000_000,
    models: [
      {
        id: 'org/qwen3-4b',
        aliases: ['qwen3-4b'],
        state: 'resident',
        pinned: true,
        estimated_bytes: 6_340_000_000,
        measured_bytes: 5_900_000_000,
      },
      {
        id: 'org/bonsai-1.7b-2bit',
        aliases: ['bonsai-1.7b-2bit'],
        state: 'resident',
        pinned: false,
        estimated_bytes: 3_410_000_000,
        measured_bytes: null,
      },
    ],
  },
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
  // `removed` and `models` are rebuilt rather than spread: a spread copies the
  // module constant's arrays (and the row objects inside `models`) by
  // REFERENCE, so every stub would share them — and the delete route mutates
  // a row's `cached` flag. The specs would see each other's deletions.
  const scenario: Scenario = {
    ...DEFAULT_SCENARIO,
    removed: [],
    statusPolls: 0,
    edits: [],
    models: DEFAULT_SCENARIO.models.map((model) => ({ ...model })),
    residency: {
      ...DEFAULT_SCENARIO.residency,
      models: DEFAULT_SCENARIO.residency.models.map((model) => ({ ...model })),
    },
    ...overrides,
  };

  /**
   * Every socket this server has accepted.
   *
   * `server.close()` stops listening but WAITS for open connections, so an
   * abandoned SSE stream hangs teardown until the test times out — surfacing
   * against whichever test happened to be running. Destroyed explicitly.
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
        "connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; " +
        "frame-ancestors 'none'; base-uri 'none'",
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
      if (scenario.statusDelayMs > 0) {
        await new Promise<void>((done) => setTimeout(done, scenario.statusDelayMs));
      }
      json(response, 200, {
        state: scenario.engineState,
        model: scenario.model,
        port: 8000,
        detail: scenario.detail,
        can_switch: scenario.canSwitch,
        // Defaults to just the primary, so a scenario that says nothing
        // about residency behaves exactly as it did before hot loading.
        resident: scenario.resident ?? (scenario.model ? [scenario.model] : []),
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
      const body = JSON.parse((await readBody(request)) || '{}') as { model?: string };
      if (scenario.loadFailure) {
        const { status, type, message } = scenario.loadFailure;
        apiError(response, status, type, message);
        return;
      }
      // Adopt the requested alias, as the real route does: the page reads
      // the response to decide what is now serving, so echoing a stale
      // `scenario.model` makes a successful switch look like a no-op.
      if (body.model) scenario.model = body.model;
      // `starting`, matching the real route: a load is minutes of work and
      // answers immediately, detached. Answering `ready` here made every
      // switch instantaneous and hid the whole loading window from the specs.
      scenario.engineState = scenario.loadSettlesReady ? 'ready' : 'starting';
      json(response, 200, {
        ok: true,
        model: scenario.model,
        state: scenario.engineState,
      });
      return;
    }

    if (path === '/api/models/remove') {
      const body = JSON.parse((await readBody(request)) || '{}') as { model?: string };
      if (scenario.removeFailure) {
        const { status, type, message } = scenario.removeFailure;
        apiError(response, status, type, message);
        return;
      }
      const alias = body.model ?? '';
      scenario.removed.push(alias);
      // Mutate the catalog too, so a refresh after the delete reflects it —
      // the page re-reads the list and the row must stop saying "on disk".
      const entry = scenario.models.find((model) => model.alias === alias);
      const freed = entry?.cached_bytes ?? null;
      if (entry) {
        entry.cached = false;
        entry.cached_bytes = null;
      }
      json(response, 200, { ok: true, model: alias, freed_bytes: freed });
      return;
    }

    if (path === '/api/models/pull') {
      const body = JSON.parse((await readBody(request)) || '{}') as { model?: string };
      const entry = scenario.models.find((model) => model.alias === body.model);
      scenario.download = {
        state: 'running',
        alias: body.model ?? '',
        done_bytes: 0,
        total_bytes: entry?.size_bytes ?? null,
      };
      json(response, 200, { ok: true, ...scenario.download });
      return;
    }

    if (path === '/api/downloads/status') {
      // A plain JSON poll. This replaced an SSE feed that trycloudflare
      // buffered indefinitely — see `fetchDownload` in src/api/models.ts.
      // Counted so a spec can prove the page stops asking once a download
      // reaches a terminal state.
      scenario.statusPolls += 1;
      json(response, 200, scenario.download ?? { state: 'idle' });
      return;
    }

    if (path === '/api/images/progress') {
      json(response, 200, scenario.imageProgress);
      return;
    }

    if (path === '/api/residency') {
      json(response, 200, scenario.residency);
      return;
    }

    if (path === '/api/images/cancel') {
      await readBody(request);
      scenario.imageProgress = { running: false, step: 0, total: 0 };
      json(response, 200, { ok: true });
      return;
    }

    if (path === '/v1/images/generations') {
      await readBody(request);
      if (scenario.imageDelayMs > 0) {
        await new Promise<void>((done) => setTimeout(done, scenario.imageDelayMs));
      }
      json(response, 200, {
        created: 1,
        data: scenario.imageResult ? [{ b64_json: scenario.imageResult }] : [],
        cancelled: false,
      });
      return;
    }

    if (path === '/api/images/edits') {
      const body = JSON.parse((await readBody(request)) || '{}') as {
        prompt?: string;
        image?: string;
        model?: string;
      };
      scenario.edits.push({ prompt: body.prompt ?? '', model: body.model ?? null });
      if (scenario.imageDelayMs > 0) {
        await new Promise<void>((done) => setTimeout(done, scenario.imageDelayMs));
      }
      json(response, 200, {
        created: 1,
        data: scenario.imageResult ? [{ b64_json: scenario.imageResult }] : [],
        cancelled: false,
      });
      return;
    }

    if (path === '/api/audio/voices') {
      if (scenario.voicesFailure) {
        const { status, type, message } = scenario.voicesFailure;
        apiError(response, status, type, message);
        return;
      }
      json(response, 200, { voices: scenario.voices });
      return;
    }

    if (path === '/api/audio/speech') {
      await readBody(request);
      // A minimal but REAL RIFF/WAVE header: the page hands this to an
      // <audio> element, and bytes that are not a container make WebKit
      // fire `error` rather than render a player.
      const header = Buffer.from(
        'UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=',
        'base64',
      );
      response.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Content-Length': header.length,
      });
      response.end(header);
      return;
    }

    if (path === '/api/audio/transcriptions') {
      await readBody(request);
      json(response, 200, {
        text: scenario.transcript,
        language: 'en',
        duration: 1.5,
      });
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

export type StubModel = Scenario['models'][number];

/**
 * A model row with the boilerplate filled in.
 *
 * Specs care about one or two fields each; spelling out all twelve every time
 * is how a new field ends up missing from half of them.
 */
export function stubModel(overrides: Partial<StubModel> & { alias: string }): StubModel {
  return {
    hf_path: `org/${overrides.alias}`,
    size_bytes: 1_000_000_000,
    cached: false,
    kind: 'text',
    loadable: true,
    cached_bytes: null,
    tool_call_parser: null,
    reasoning_parser: null,
    is_text_only: true,
    audio_kind: null,
    family: null,
    // Null for the default (text) kind; an image row must set it explicitly,
    // since it decides which request shapes the surface offers.
    image_capability: null,
    ...overrides,
  };
}

/**
 * Open the model list.
 *
 * It lives in the Settings window's Models panel, reached from the sidebar
 * footer — the sidebar's old "Choose a model" row is gone, since the picker
 * now sits in the composer. Centralised because a dozen specs need it and the
 * route has already moved twice.
 */
export async function openModelList(page: import('@playwright/test').Page) {
  const drawerToggle = page.getByLabel('Open sidebar');
  if (await drawerToggle.isVisible()) await drawerToggle.click();
  await page.getByRole('button', { name: 'Settings' }).click();

  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'Models' }).click();
  return dialog;
}

export { chatFrame, usageFrame };
