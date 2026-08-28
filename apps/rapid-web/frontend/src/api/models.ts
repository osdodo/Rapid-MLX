import { request, requestJson } from './client';
import type { DownloadJob, ModelsResponse, RemovalResult, StatusResponse } from './types';

export function fetchStatus(signal?: AbortSignal): Promise<StatusResponse> {
  return requestJson<StatusResponse>('/api/status', signal ? { signal } : {});
}

export function fetchModels(refresh = false): Promise<ModelsResponse> {
  return requestJson<ModelsResponse>(`/api/models${refresh ? '?refresh=true' : ''}`);
}

/**
 * Switch the loaded model.
 *
 * Kills the engine child, so the server refuses with 409 while a chat stream
 * is being relayed (``busy_streaming``) or another load is already in flight
 * (``busy_loading``), and with 409 ``switch_unavailable`` in --attach mode
 * where this process does not own the engine. All three arrive as an
 * ``ApiError`` carrying that code; the caller decides which notice to raise.
 */
export function loadModel(alias: string): Promise<{ ok: true; model: string; state: string }> {
  return requestJson('/api/models/load', {
    method: 'POST',
    body: { model: alias },
  });
}

export function pullModel(alias: string): Promise<DownloadJob> {
  return requestJson<DownloadJob>('/api/models/pull', {
    method: 'POST',
    body: { model: alias },
  });
}

/**
 * Delete a model's weights from the Mac's HuggingFace cache.
 *
 * POST rather than DELETE, matching the server: the CSRF content-type check
 * runs on POST/PUT/PATCH, so this is the method that carries it (app.py).
 *
 * Refused with 409 ``model_in_use`` when the alias is the one the engine is
 * running or is mid-download — deleting either would unlink files something
 * else has open.
 */
export function removeModel(alias: string): Promise<RemovalResult> {
  return requestJson<RemovalResult>('/api/models/remove', {
    method: 'POST',
    body: { model: alias },
  });
}

export async function cancelDownload(): Promise<void> {
  await request('/api/downloads/cancel', { method: 'POST', body: {} });
}

/**
 * The current download job, or ``{ state: 'idle' }`` when there is none.
 *
 * Polled, NOT streamed — and the SSE feed this replaced was not removed for
 * tidiness. Measured against a real ``trycloudflare`` tunnel: response headers
 * arrived in 1.8 s and then not one body byte in 65 s, while the same endpoint
 * on loopback delivered its first frame in 0.0 s. Cloudflare strips the
 * ``X-Accel-Buffering: no`` hint (an nginx convention it does not honour), and
 * padding the first frame to 2 KiB did not shake it loose either.
 *
 * The chat stream survives the same tunnel because it emits tokens
 * continuously; a download feed that sends 25 bytes and then a keepalive every
 * 15 s is far too sparse to break through the buffer. Progress is
 * low-frequency data, so a poll costs nothing a long-lived connection was
 * buying.
 */
export function fetchDownload(signal?: AbortSignal): Promise<DownloadJob> {
  return requestJson<DownloadJob>('/api/downloads/status', signal ? { signal } : {});
}
