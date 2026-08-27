import { ApiError } from './errors';
import { request } from './client';
import { readJsonEventStream } from './sse';

/** A turn as it goes on the wire. Nothing local (stats, ids, reasoning) rides
 *  along — the engine only ever sees role and content. */
export interface WireTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  turns: WireTurn[];
  temperature: number;
  topP: number;
  maxTokens: number;
  signal: AbortSignal;
}

/** One decoded piece of a streamed answer. */
export type ChatDelta =
  | { kind: 'content'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'usage'; completionTokens: number };

/** The subset of the OpenAI streaming shape this client reads. */
interface ChatChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      /** Reasoning models stream their scratchpad here, ahead of the answer. */
      reasoning_content?: string | null;
    };
  }>;
  usage?: { completion_tokens?: number };
  error?: { message?: string; type?: string };
}

/**
 * Stream a chat completion.
 *
 * A POST rather than an ``EventSource`` for two independent reasons: the
 * request carries a body, and ``EventSource`` cannot set the ``Authorization``
 * header this server requires.
 */
export async function* streamChat(options: ChatRequest): AsyncGenerator<ChatDelta> {
  const response = await request('/v1/chat/completions', {
    method: 'POST',
    signal: options.signal,
    body: {
      messages: options.turns,
      stream: true,
      temperature: options.temperature,
      top_p: options.topP,
      max_tokens: options.maxTokens,
      // Without this the engine sends no usage frame and the token count has
      // to be estimated from character length, which is off by a wide and
      // model-dependent margin.
      stream_options: { include_usage: true },
    },
  });

  if (!response.body) return;

  for await (const chunk of readJsonEventStream<ChatChunk>(response.body, options.signal)) {
    // An error can arrive mid-stream, after a 200 and after real content: the
    // engine hit something partway through generating. It is a hard stop, not
    // a frame to skip.
    if (chunk.error) {
      throw new ApiError(
        502,
        chunk.error.type ?? 'engine_error',
        chunk.error.message ?? 'engine error',
      );
    }

    // A usage frame carries no delta, so it must return rather than fall
    // through into the choices lookup.
    if (chunk.usage) {
      yield {
        kind: 'usage',
        completionTokens: chunk.usage.completion_tokens ?? 0,
      };
      continue;
    }

    const delta = chunk.choices?.[0]?.delta;
    if (!delta) continue;

    if (delta.reasoning_content) yield { kind: 'reasoning', text: delta.reasoning_content };
    if (delta.content) yield { kind: 'content', text: delta.content };
  }
}
