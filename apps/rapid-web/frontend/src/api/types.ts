/**
 * Wire types, mirroring the server exactly.
 *
 * These are transcriptions of Python dataclasses, so each one cites its
 * source. When the server changes, this file changes with it — nothing else
 * in the app should be reading raw JSON.
 */

/** ``supervisor.ChildState`` — supervisor.py:54-60. */
export type EngineState = 'stopped' | 'starting' | 'ready' | 'failed';

/** ``supervisor.ChildStatus.to_dict`` — supervisor.py:82-88, plus the two
 *  fields ``app.py`` grafts on at the route (app.py:283-288). */
export interface StatusResponse {
  state: EngineState;
  model: string | null;
  port: number | null;
  detail: string | null;
  can_switch: boolean;
  /** Only present on a failure; the engine's recent log tail. */
  recent_output?: string[];
}

/** ``catalog.ModelEntry.to_dict`` — catalog.py:76-86. */
export interface ModelEntry {
  alias: string;
  hf_path: string;
  size_bytes: number | null;
  cached: boolean;
  cached_bytes: number | null;
  tool_call_parser: string | null;
  reasoning_parser: string | null;
  /**
   * NOT a trustworthy capability signal, and deliberately unused for one.
   * The catalog has claimed vision for checkpoints that 400 every image; only
   * a loaded engine knows, via ``/v1/models/{alias}``'s ``capabilities``. It
   * is carried here because the server sends it, not because anything should
   * branch on it.
   */
  is_text_only: boolean;
}

export interface ModelsResponse {
  models: ModelEntry[];
  loaded: string | null;
  state: EngineState;
  can_switch: boolean;
  allow_downloads: boolean;
}

/** ``POST /api/models/remove``. ``freed_bytes`` is null when the cached scan
 *  had no size for the snapshot — "unknown", never zero. */
export interface RemovalResult {
  ok: true;
  model: string;
  freed_bytes: number | null;
}

/** ``downloads.DownloadState`` — downloads.py:62-66, plus the synthetic
 *  ``idle`` the SSE generator emits when no job exists (app.py:558). */
export type DownloadState = 'idle' | 'running' | 'done' | 'failed' | 'cancelled';

/** ``downloads.DownloadJob.to_dict`` — downloads.py:84-95. */
export interface DownloadJob {
  state: DownloadState;
  alias?: string;
  done_bytes?: number;
  total_bytes?: number | null;
  detail?: string | null;
}

/** ``GET /api/config`` — app.py:250-259. The only unauthenticated JSON
 *  endpoint, and it answers exactly one question. */
export interface ConfigResponse {
  auth_required: boolean;
}

/** ``POST /api/auth`` — app.py:261-276. */
export interface AuthResponse {
  ok: true;
  can_switch: boolean;
  allow_downloads: boolean;
}

/** The uniform error envelope — app.py:108-117. Matches the engine's own
 *  shape, so proxied and locally-generated failures have one error path. */
export interface ErrorEnvelope {
  error: { message: string; type: string };
}
