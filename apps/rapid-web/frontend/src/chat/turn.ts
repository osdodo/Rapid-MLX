import { streamChat } from '../api/chat';
import { asApiError } from '../api/errors';
import { useStore, wireTurns } from '../state/store';
import type { MessageNode } from '../state/types';
import { activePath, branchAnchor, siblings } from './MessageTree';
import { streamingStore } from './StreamingStore';

/**
 * Running a turn.
 *
 * All four entry points — send, retry, edit-and-resend, and the branch walk
 * that follows a deletion — go through `runTurn`, so there is one definition
 * of what a turn does and one place the stream is wired up.
 */

let inFlight: AbortController | null = null;

export function isStreaming(): boolean {
  return inFlight !== null;
}

export function stopTurn(): void {
  inFlight?.abort();
}

interface RunOptions {
  /** The node the answer is written into. Created by the caller. */
  assistantId: string;
  /** The path to send, already rewound to the right point. */
  path: MessageNode[];
  alias: string | null;
}

/**
 * Stream one answer into `assistantId`.
 *
 * The node is created BEFORE this runs and patched exactly once at the end.
 * Nothing per-token touches the app store: the live text lives in
 * StreamingStore, which is what keeps a 400 ms persist debounce from
 * stringifying the whole store ten times a second.
 */
export async function runTurn({ assistantId, path, alias }: RunOptions): Promise<void> {
  const store = useStore.getState();
  const controller = new AbortController();
  inFlight = controller;

  streamingStore.start();

  const startedAt = performance.now();
  let firstTokenAt: number | null = null;
  let engineTokens: number | null = null;

  try {
    const deltas = streamChat({
      turns: wireTurns(path, store.settings.system),
      temperature: store.settings.temperature,
      topP: store.settings.topP,
      maxTokens: store.settings.maxTokens,
      signal: controller.signal,
    });

    for await (const delta of deltas) {
      switch (delta.kind) {
        case 'content':
          firstTokenAt ??= performance.now();
          streamingStore.appendContent(delta.text);
          break;
        case 'reasoning':
          // TTFT is not stamped here: reasoning arrives before the answer
          // does, and counting it would report a time-to-first-token that
          // does not correspond to any token the user can read.
          streamingStore.appendReasoning(delta.text);
          break;
        case 'usage':
          engineTokens = delta.completionTokens;
          break;
      }
    }

    commit({
      assistantId,
      startedAt,
      firstTokenAt,
      engineTokens,
      alias,
      status: 'complete',
    });
  } catch (cause) {
    if (controller.signal.aborted) {
      // A stopped turn KEEPS what arrived. The user pressed stop because they
      // had read enough, not because they wanted it thrown away.
      commit({
        assistantId,
        startedAt,
        firstTokenAt,
        engineTokens,
        alias,
        status: 'complete',
      });
      return;
    }

    const error = asApiError(cause);
    streamingStore.flush();
    const { content, reasoning } = streamingStore.current();

    useStore.getState().patchNode(assistantId, {
      content,
      ...(reasoning ? { reasoning } : {}),
      status: 'failed',
      error: { type: error.type, message: error.message },
      ...(alias ? { model: alias } : {}),
    });
  } finally {
    if (inFlight === controller) inFlight = null;
  }
}

interface CommitOptions {
  assistantId: string;
  alias: string | null;
  startedAt: number;
  firstTokenAt: number | null;
  engineTokens: number | null;
  status: 'complete';
}

function commit({
  assistantId,
  startedAt,
  firstTokenAt,
  engineTokens,
  alias,
  status,
}: CommitOptions): void {
  // Flush first: the last few tokens must not be sitting on a timer when the
  // final content is read.
  streamingStore.flush();
  const { content, reasoning } = streamingStore.current();

  const elapsedMs = performance.now() - startedAt;
  // The engine's own count when `stream_options.include_usage` produced one.
  // The character estimate is a fallback and is MARKED as one, because it is
  // off by a wide and model-dependent margin.
  const estimated = engineTokens === null;
  const tokens = engineTokens ?? Math.round(content.length / 4);

  useStore.getState().patchNode(assistantId, {
    content,
    ...(reasoning ? { reasoning } : {}),
    status,
    ...(alias ? { model: alias } : {}),
    stats: {
      ttftMs: firstTokenAt === null ? null : firstTokenAt - startedAt,
      tokens,
      tps: elapsedMs > 0 && tokens > 0 ? tokens / (elapsedMs / 1000) : null,
      tokensEstimated: estimated,
    },
  });
}

// ------------------------------------------------------------ entry points

/** Send a new prompt at the end of the visible transcript. */
export function send(text: string): void {
  const store = useStore.getState();
  if (store.activeId === null) store.createConversation();

  const alias = store.selectedAlias;
  useStore.getState().appendNode({
    parentId: currentLeaf(),
    role: 'user',
    content: text,
    status: 'complete',
  });

  const assistantId = useStore.getState().appendNode({
    parentId: currentLeaf(),
    role: 'assistant',
    content: '',
    status: 'streaming',
  });

  void runTurn({ assistantId, path: pathExcluding(assistantId), alias });
}

/**
 * Re-answer an existing prompt.
 *
 * Message-addressed, not "regenerate the last turn": the path is rewound to
 * just AFTER the owning user prompt, so the prompt is reused and the new
 * answer lands as a true sibling of the old one. Rewinding past the prompt
 * and re-sending its text would append a duplicate prompt and put the two
 * answers in different branches entirely.
 */
export function retry(nodeId: string): void {
  const store = useStore.getState();
  const conversation = activeConversation();
  if (!conversation) return;

  const node = conversation.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return;

  const anchor = branchAnchor(nodeId, conversation.nodes);
  const anchorNode = conversation.nodes.find((candidate) => candidate.id === anchor);
  const parentId = anchorNode?.parentId ?? node.parentId;

  const assistantId = store.appendNode({
    parentId,
    role: 'assistant',
    content: '',
    status: 'streaming',
  });

  void runTurn({
    assistantId,
    path: pathExcluding(assistantId),
    alias: store.selectedAlias,
  });
}

/**
 * Edit a user message and re-send it.
 *
 * The new prompt is a SIBLING of the original, so the pre-edit prompt and
 * everything under it survive one `‹1/2›` away. Stays on the same
 * conversation: forking to a new one here means every edit grows a
 * near-identical row in the sidebar until the list is unusable.
 */
export function editAndResend(nodeId: string, text: string): void {
  const store = useStore.getState();
  const conversation = activeConversation();
  if (!conversation) return;

  const node = conversation.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return;

  store.appendNode({
    parentId: node.parentId,
    role: 'user',
    content: text,
    status: 'complete',
  });

  const assistantId = useStore.getState().appendNode({
    parentId: currentLeaf(),
    role: 'assistant',
    content: '',
    status: 'streaming',
  });

  void runTurn({
    assistantId,
    path: pathExcluding(assistantId),
    alias: store.selectedAlias,
  });
}

/** Step to the previous or next alternative at this fork. */
export function switchBranch(nodeId: string, direction: -1 | 1): void {
  const conversation = activeConversation();
  if (!conversation) return;

  const anchor = branchAnchor(nodeId, conversation.nodes);
  if (anchor === null) return;

  const group = siblings(anchor, conversation.nodes);
  const index = group.findIndex((candidate) => candidate.id === anchor);
  const next = group[index + direction];
  // Bounded: the ends are a no-op, which is what the disabled arrows say.
  if (!next) return;

  useStore.getState().setActiveLeaf(next.id);
}

/** Where a node sits in its sibling group, or null if it has no alternatives. */
export function branchPosition(
  nodeId: string,
  nodes: MessageNode[],
): { index: number; total: number } | null {
  const anchor = branchAnchor(nodeId, nodes);
  if (anchor === null) return null;
  const group = siblings(anchor, nodes);
  if (group.length <= 1) return null;
  return {
    index: group.findIndex((candidate) => candidate.id === anchor),
    total: group.length,
  };
}

// ----------------------------------------------------------------- helpers

function activeConversation() {
  const state = useStore.getState();
  return state.conversations.find((conversation) => conversation.id === state.activeId) ?? null;
}

function currentLeaf(): string | null {
  return activeConversation()?.activeLeafId ?? null;
}

/** The visible path with the in-flight placeholder removed. */
function pathExcluding(assistantId: string): MessageNode[] {
  const conversation = activeConversation();
  if (!conversation) return [];
  return activePath(
    conversation.nodes,
    conversation.activeLeafId,
    conversation.branchChoices,
  ).filter((node) => node.id !== assistantId);
}
