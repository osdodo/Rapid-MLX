import { request, requestJson } from './client';
import type { ImageProgress, ImageResponse } from './types';

export interface GenerateOptions {
  prompt: string;
  size: string;
  model?: string | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * Render one image.
 *
 * ``b64_json`` is the only response format the local lane offers — there is no
 * object store to host a URL — so it is pinned here rather than exposed.
 */
export function generateImage({
  prompt,
  size,
  model,
  signal,
}: GenerateOptions): Promise<ImageResponse> {
  return requestJson<ImageResponse>('/v1/images/generations', {
    method: 'POST',
    body: { prompt, size, n: 1, response_format: 'b64_json', ...(model ? { model } : {}) },
    ...(signal ? { signal } : {}),
  });
}

export interface EditOptions {
  /** The source image as base64 PNG/JPEG bytes, without a data: prefix. */
  image: string;
  prompt: string;
  model?: string | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * Instruction-edit an image.
 *
 * Sent as JSON with the source base64-encoded, not as a multipart: the
 * server's CSRF control rejects the CORS-simple content types and rebuilds
 * the multipart itself. No ``size`` — the edit backends derive their canvas
 * from the input image.
 */
export function editImage({ image, prompt, model, signal }: EditOptions): Promise<ImageResponse> {
  return requestJson<ImageResponse>('/api/images/edits', {
    method: 'POST',
    body: { image, prompt, ...(model ? { model } : {}) },
    ...(signal ? { signal } : {}),
  });
}

/** Polled while a render runs — same reasoning as the download feed. */export function fetchImageProgress(signal?: AbortSignal): Promise<ImageProgress> {
  return requestJson<ImageProgress>('/api/images/progress', signal ? { signal } : {});
}

/** Asks the engine to stop at the next denoise step. */
export async function cancelImage(model?: string): Promise<void> {
  await request('/api/images/cancel', { method: 'POST', body: model ? { model } : {} });
}
