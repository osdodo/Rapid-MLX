/**
 * The persisted domain model.
 *
 * The single most important change from the old page: `messages` used to be a
 * live alias into `store.conversations[i].messages`, and every mutation path
 * (`push`, `splice`, in-place `stats` assignment) depended on the two names
 * pointing at the same array object (index.html:1098-1102, :1852-1859). There
 * is no such variable here. Reads go through `selectActivePath`, writes go
 * through store actions, and nothing outside the conversations slice touches
 * the node bag.
 */

export type Role = 'system' | 'user' | 'assistant';

export type MessageStatus = 'complete' | 'streaming' | 'failed';

export interface TurnStats {
  /** Time to first token, in milliseconds. Null when the turn produced none. */
  ttftMs: number | null;
  tokens: number;
  /** Tokens per second over the whole turn, including the wait for the first. */
  tps: number | null;
  /**
   * True when `tokens` was derived from `content.length / 4` because the
   * engine sent no usage frame. The estimate is off by a wide and
   * model-dependent margin, so the caption marks it rather than presenting a
   * guess as a measurement.
   */
  tokensEstimated: boolean;
}

export interface MessageNode {
  id: string;
  /**
   * The only edge. Children and siblings are recomputed by scan — see
   * chat/MessageTree.ts for why a bidirectional link was rejected.
   */
  parentId: string | null;
  role: Role;
  content: string;
  /** A reasoning model's scratchpad, shown in a collapsed disclosure. */
  reasoning?: string;
  status: MessageStatus;
  /** Sibling ordering key. Also what `precedes` sorts on. */
  createdAt: number;
  /** Kept on a failed turn so the UI can branch on the code, not the prose. */
  error?: { type: string; message: string };
  stats?: TurnStats;
  /** Which alias produced this answer. Lets a failure be attributed. */
  model?: string;
}

export interface Conversation {
  id: string;
  title: string;
  /**
   * Set by an explicit rename. Stops the auto-derivation from the first user
   * message stomping a title the user chose.
   */
  hasCustomTitle: boolean;
  createdAt: number;
  updatedAt: number;
  /**
   * Every branch, as one unsorted bag. The visible transcript is
   * `activePath(nodes, activeLeafId, branchChoices)`.
   */
  nodes: MessageNode[];
  activeLeafId: string | null;
  /**
   * parent -> last-chosen-child, so returning to a branch lands where the
   * user left it rather than at its deepest tip.
   */
  branchChoices: Record<string, string>;
  isPinned: boolean;
  isArchived: boolean;
  folderId: string | null;
}

export interface Folder {
  id: string;
  name: string;
  createdAt: number;
}

export interface Settings {
  system: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  /** Auto follows `prefers-color-scheme`; the other two override it. */
  theme: 'auto' | 'light' | 'dark';
  /**
   * Escape hatch for a browser without MathML Core — an old Android WebView
   * renders MathML as flattened text. `source` shows the LaTeX verbatim in a
   * monospace face, which is honest and readable. Defaulted by a feature
   * probe at boot rather than left for the user to discover.
   */
  mathRendering: 'mathml' | 'source';
}

export const DEFAULT_SETTINGS: Settings = {
  system: '',
  temperature: 0.7,
  topP: 0.95,
  maxTokens: 2048,
  theme: 'auto',
  mathRendering: 'mathml',
};

/** The persisted envelope. v3 is the first shape to carry its own version. */
export const SCHEMA_VERSION = 3;

export interface PersistedStore {
  v: typeof SCHEMA_VERSION;
  conversations: Conversation[];
  folders: Folder[];
  activeId: string | null;
}
