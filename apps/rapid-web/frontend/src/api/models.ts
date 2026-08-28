import { request, requestJson } from './client';
import { readJsonEventStream } from './sse';
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
 * The download progress feed.
 *
 * The server deliberately never closes this stream, even after a job reaches a
 * terminal state (app.py:539-550). Closing on done/cancelled looks right and
 * passes every single-download test, but the manager retains the last finished
 * job — so a client connecting afterwards would immediately see the terminal
 * frame, get ``[DONE]`` and disconnect, and a *subsequent* download would then
 * have no live feed at all. The caller is therefore responsible for aborting
 * once it has seen what it needs.
 */
export async function* watchDownloads(signal: AbortSignal): AsyncGenerator<DownloadJob> {
  const response = await request('/api/downloads/stream', { signal });
  if (!response.body) return;
  yield* readJsonEventStream<DownloadJob>(response.body, signal);
}
