import { request, requestJson } from './client';

/**
 * The audio lane.
 *
 * It rides on WHATEVER model the engine is serving — the child is spawned
 * with `--enable-audio` — so nothing here switches models. Speech works while
 * a chat model is loaded, which is the whole reason audio is not in the model
 * picker.
 */

export interface Transcription {
  text: string;
  language?: string | null;
  duration?: number | null;
}

export function fetchVoices(model?: string): Promise<{ voices: string[] }> {
  const query = model ? `?model=${encodeURIComponent(model)}` : '';
  return requestJson<{ voices: string[] }>(`/api/audio/voices${query}`);
}

export interface SpeechOptions {
  input: string;
  model: string;
  voice: string;
  speed: number;
  signal?: AbortSignal | undefined;
}

/**
 * Synthesise speech. Resolves to the audio itself, not JSON.
 *
 * `response_format` is pinned to wav: it is the one format every family
 * emits, and `<audio>` plays it everywhere. mp3/opus are engine-side options
 * that would only add a control with no audible benefit here.
 */
export async function synthesize({
  input,
  model,
  voice,
  speed,
  signal,
}: SpeechOptions): Promise<Blob> {
  const response = await request('/api/audio/speech', {
    method: 'POST',
    body: { input, model, voice, speed, response_format: 'wav' },
    ...(signal ? { signal } : {}),
  });
  return await response.blob();
}

export interface TranscribeOptions {
  audio: Blob;
  model?: string | undefined;
  /** Proper nouns to bias the decoder toward. */
  context?: string | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * Transcribe a recording.
 *
 * Sent as base64 inside JSON rather than as a multipart upload: the server's
 * CSRF control rejects the CORS-simple content types and `multipart/form-data`
 * is one of them. The ~33% wire cost buys one security policy instead of two.
 */
export async function transcribe({
  audio,
  model,
  context,
  signal,
}: TranscribeOptions): Promise<Transcription> {
  return requestJson<Transcription>('/api/audio/transcriptions', {
    method: 'POST',
    body: {
      audio: await toBase64(audio),
      filename: filenameFor(audio.type),
      ...(model ? { model } : {}),
      ...(context ? { context } : {}),
    },
    ...(signal ? { signal } : {}),
  });
}

/**
 * Base64 without `FileReader`'s data-URI wrapper.
 *
 * Chunked: `String.fromCharCode(...bytes)` on a multi-megabyte recording
 * exceeds the argument limit and throws `RangeError`.
 */
async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}

/**
 * Advisory only — the engine spools every upload to a `.wav` temp file and
 * decodes the CONTAINER, not the extension. Recordings are already
 * transcoded to WAV by `audio/recorder.ts`, so this reports what the bytes
 * actually are rather than renaming them into something they are not.
 */
function filenameFor(mime: string): string {
  if (mime.includes('webm')) return 'recording.webm';
  if (mime.includes('mp4') || mime.includes('m4a')) return 'recording.mp4';
  if (mime.includes('ogg')) return 'recording.ogg';
  return 'recording.wav';
}
