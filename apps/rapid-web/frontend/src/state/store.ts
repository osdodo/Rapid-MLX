import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { DownloadJob, ModelEntry, StatusResponse } from '@/api/types';
import { activePath, choicesAlong, deepestLeaf } from '@/chat/MessageTree';
import { newId } from '@/lib/ids';
import { HISTORY_BACKUP_KEY, HISTORY_KEY, deriveTitle, migrate } from './migrate';
import { persist } from './persist';
import {
  DEFAULT_SETTINGS,
  SCHEMA_VERSION,
  type Conversation,
  type MessageNode,
  type Role,
  type Settings,
} from './types';

/**
 * The application store.
 *
 * zustand rather than context + useReducer: one context holding this would
 * re-render every consumer on every change, and fixing that means sharding
 * into half a dozen contexts with hand-rolled selector equality — zustand,
 * reimplemented worse. Measured at 9 KB.
 *
 * STREAMING TEXT NEVER ENTERS THIS STORE. It lives in chat/StreamingStore and
 * is committed here once, at stream end, so the persist debounce does not
 * stringify the whole store ten times a second.
 */

// Pre-rename spelling, kept deliberately — see `HISTORY_KEY` in
// state/migrate.ts.
const SETTINGS_KEY = 'rapid-mlx-web.settings';

/** Trailing, so a burst of slider drags produces one write rather than sixty. */
const PERSIST_DEBOUNCE_MS = 400;

function safeRead(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // Safari private browsing throws on access, not just on write.
    return null;
  }
}

function safeWrite(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Losing a preference is survivable; taking the app down for it is not.
  }
}

function loadSettings(): Settings {
  const raw = safeRead(SETTINGS_KEY);
  if (raw === null) return DEFAULT_SETTINGS;
  try {
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      system: typeof parsed.system === 'string' ? parsed.system : DEFAULT_SETTINGS.system,
      temperature: numberOr(parsed.temperature, DEFAULT_SETTINGS.temperature),
      topP: numberOr(parsed.topP, DEFAULT_SETTINGS.topP),
      maxTokens: numberOr(parsed.maxTokens, DEFAULT_SETTINGS.maxTokens),
      theme:
        parsed.theme === 'light' || parsed.theme === 'dark' || parsed.theme === 'auto'
          ? parsed.theme
          : DEFAULT_SETTINGS.theme,
      mathRendering: parsed.mathRendering === 'source' ? 'source' : DEFAULT_SETTINGS.mathRendering,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export interface Notice {
  id: string;
  tone: 'info' | 'warning' | 'error';
  title: string;
  body?: string | undefined;
  action?: { label: string; run: () => void } | undefined;
}

interface StoreState {
  // ---- conversations
  conversations: Conversation[];
  activeId: string | null;
  /** False when storage holds a newer schema; every write is suppressed. */
  writable: boolean;

  // ---- session
  status: StatusResponse | null;
  statusFailures: number;
  models: ModelEntry[];
  catalogLoaded: boolean;
  selectedAlias: string | null;
  canSwitch: boolean;
  allowDownloads: boolean;
  download: DownloadJob | null;
  notices: Notice[];
  /** Bumped when a gated send is attempted, to flash the readiness surface. */
  attentionToken: number;

  settings: Settings;

  // ---- actions
  createConversation(): string;
  setActiveConversation(id: string): void;
  deleteConversation(id: string): void;
  /** Pin, archive, rename. Deliberately does NOT touch `updatedAt` — see
   *  the action for why. */
  updateConversation(id: string, patch: Partial<Conversation>): void;
  appendNode(
    node: Omit<MessageNode, 'id' | 'createdAt'> & Partial<Pick<MessageNode, 'id' | 'createdAt'>>,
  ): string;
  patchNode(id: string, patch: Partial<MessageNode>): void;
  removeSubtree(ids: Set<string>): void;
  setActiveLeaf(leafId: string): void;

  setStatus(status: StatusResponse | null, failed: boolean): void;
  setModels(models: ModelEntry[]): void;
  setCapabilities(canSwitch: boolean, allowDownloads: boolean): void;
  selectAlias(alias: string | null): void;
  setDownload(job: DownloadJob | null): void;

  pushNotice(notice: Omit<Notice, 'id'>): void;
  dismissNotice(id: string): void;
  flagBlockedSend(): void;

  updateSettings(patch: Partial<Settings>): void;
}

const boot = migrate(safeRead(HISTORY_KEY), (raw) => safeWrite(HISTORY_BACKUP_KEY, raw));

export const useStore = create<StoreState>()((set, get) => {
  let persistTimer: ReturnType<typeof setTimeout> | undefined;

  /** Debounced write. `flushPersist` is exported below for the unload path. */
  const schedulePersist = () => {
    if (!get().writable) return;
    if (persistTimer !== undefined) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = undefined;
      flushPersist();
    }, PERSIST_DEBOUNCE_MS);
  };

  const flushPersist = () => {
    const state = get();
    if (!state.writable) return;
    if (persistTimer !== undefined) {
      clearTimeout(persistTimer);
      persistTimer = undefined;
    }
    persist(
      {
        v: SCHEMA_VERSION,
        conversations: state.conversations,
        folders: [],
        activeId: state.activeId,
      },
      localStorage,
    );
  };

  /** Apply `mutate` to the active conversation and schedule a write. */
  const updateActive = (mutate: (conversation: Conversation) => Conversation) => {
    set((state) => {
      if (state.activeId === null) return state;
      return {
        conversations: state.conversations.map((conversation) =>
          conversation.id === state.activeId ? mutate(conversation) : conversation,
        ),
      };
    });
    schedulePersist();
  };

  /**
   * Bump `updatedAt` and back-fill the title.
   *
   * Deliberately NOT called by branch switching: navigating between existing
   * answers is not work, and reshuffling the sidebar for it would move a
   * conversation to the top for merely being looked at.
   */
  const touch = (conversation: Conversation): Conversation => ({
    ...conversation,
    updatedAt: Date.now(),
    title: conversation.hasCustomTitle
      ? conversation.title
      : conversation.title ||
        deriveTitle(
          activePath(conversation.nodes, conversation.activeLeafId, conversation.branchChoices),
        ),
  });

  return {
    conversations: boot.store.conversations,
    activeId: boot.store.activeId,
    writable: boot.writable,

    status: null,
    statusFailures: 0,
    models: [],
    catalogLoaded: false,
    selectedAlias: null,
    canSwitch: false,
    allowDownloads: false,
    download: null,
    notices: [],
    attentionToken: 0,

    settings: loadSettings(),

    createConversation() {
      const id = newId();
      const now = Date.now();
      set((state) => ({
        conversations: [
          {
            id,
            title: '',
            hasCustomTitle: false,
            createdAt: now,
            updatedAt: now,
            nodes: [],
            activeLeafId: null,
            branchChoices: {},
            isPinned: false,
            isArchived: false,
            folderId: null,
          },
          ...state.conversations,
        ],
        activeId: id,
      }));
      schedulePersist();
      return id;
    },

    setActiveConversation(id) {
      set({ activeId: id });
      schedulePersist();
    },

    deleteConversation(id) {
      set((state) => {
        const conversations = state.conversations.filter((conversation) => conversation.id !== id);
        return {
          conversations,
          activeId: state.activeId === id ? (conversations[0]?.id ?? null) : state.activeId,
        };
      });
      schedulePersist();
    },

    updateConversation(id, patch) {
      set((state) => ({
        conversations: state.conversations.map((conversation) =>
          conversation.id === id ? { ...conversation, ...patch } : conversation,
        ),
      }));
      // `updatedAt` is deliberately NOT bumped. Pinning, archiving or
      // renaming is organising the list, not working in the conversation, and
      // moving a row to the top of "Today" for having been renamed is exactly
      // the opposite of what the user was trying to do.
      schedulePersist();
    },

    appendNode(partial) {
      const id = partial.id ?? newId();
      const node: MessageNode = {
        ...partial,
        id,
        createdAt: partial.createdAt ?? Date.now(),
      };

      updateActive((conversation) => {
        const nodes = [...conversation.nodes, node];
        const path = activePath(nodes, id, conversation.branchChoices);
        return touch({
          ...conversation,
          nodes,
          activeLeafId: id,
          // Merged, not replaced: a fork the user has not visited this session
          // must keep the position it had.
          branchChoices: {
            ...conversation.branchChoices,
            ...choicesAlong(path),
          },
        });
      });

      return id;
    },

    patchNode(id, patch) {
      updateActive((conversation) => ({
        ...conversation,
        nodes: conversation.nodes.map((node) => (node.id === id ? { ...node, ...patch } : node)),
        updatedAt: Date.now(),
      }));
    },

    removeSubtree(ids) {
      updateActive((conversation) => {
        const nodes = conversation.nodes.filter((node) => !ids.has(node.id));

        // Prune the doomed edges BEFORE resolving a new leaf, or a stale edge
        // steers the walk at the very fork the user is standing on.
        const choices: Record<string, string> = {};
        for (const [parent, child] of Object.entries(conversation.branchChoices)) {
          if (!ids.has(parent) && !ids.has(child)) choices[parent] = child;
        }

        const leafGone = conversation.activeLeafId === null || ids.has(conversation.activeLeafId);
        return {
          ...conversation,
          nodes,
          branchChoices: choices,
          activeLeafId: leafGone ? null : conversation.activeLeafId,
        };
      });
    },

    setActiveLeaf(leafId) {
      updateActive((conversation) => {
        // Resolve DOWNWARDS so returning to a branch lands where the user left
        // it rather than at its deepest tip.
        const resolved = deepestLeaf(leafId, conversation.nodes, conversation.branchChoices);
        const path = activePath(conversation.nodes, resolved, conversation.branchChoices);
        return {
          ...conversation,
          activeLeafId: resolved,
          branchChoices: {
            ...conversation.branchChoices,
            ...choicesAlong(path),
          },
          // `updatedAt` deliberately untouched — see `touch`.
        };
      });
    },

    setStatus(status, failed) {
      set((state) => ({
        status: status ?? state.status,
        statusFailures: failed ? state.statusFailures + 1 : 0,
        canSwitch: status?.can_switch ?? state.canSwitch,
        // Adopt the serving model as the selection until the user picks one,
        // so a page opened against a running engine is immediately usable.
        selectedAlias: state.selectedAlias ?? status?.model ?? null,
      }));
    },

    setModels(models) {
      set({ models, catalogLoaded: true });
    },

    setCapabilities(canSwitch, allowDownloads) {
      set({ canSwitch, allowDownloads });
    },

    selectAlias(alias) {
      set((state) => ({
        selectedAlias: alias,
        // Mark the status as no longer describing the selection. Without this
        // the cached snapshot still names the PREVIOUS model, so
        // `resolveReadiness` finds no serving state and tells the user to
        // press Start on something that is already starting.
        //
        // `null`, not a synthesised "starting": we do not know yet, and null
        // resolves to `needsStart` at worst, which is honest.
        status: alias !== null && alias !== state.status?.model ? null : state.status,
      }));
    },

    setDownload(job) {
      set({ download: job });
    },

    pushNotice(notice) {
      set((state) => ({
        notices: [...state.notices, { ...notice, id: newId() }],
      }));
    },

    dismissNotice(id) {
      set((state) => ({
        notices: state.notices.filter((notice) => notice.id !== id),
      }));
    },

    flagBlockedSend() {
      set((state) => ({ attentionToken: state.attentionToken + 1 }));
    },

    updateSettings(patch) {
      set((state) => {
        const settings = { ...state.settings, ...patch };
        safeWrite(SETTINGS_KEY, JSON.stringify(settings));
        return { settings };
      });
    },
  };
});

/**
 * Force a write immediately, bypassing the debounce.
 *
 * Reads the store rather than reaching into the factory's closure. An earlier
 * version assigned a mutable module-level binding from the factory, which is a
 * TDZ error — `create()` runs during module evaluation, before the `let` below
 * it exists — so the bundle threw on load and the page rendered nothing. Only
 * e2e catches this: unit tests import the store lazily, never in load order.
 *
 * iOS Safari kills a backgrounded tab WITHOUT firing `beforeunload`, so
 * `visibilitychange` is the one that fires on a phone and `pagehide` covers
 * bfcache. All three are registered because which fires depends on the
 * teardown path.
 */
export function flushPersistNow(): void {
  const state = useStore.getState();
  if (!state.writable) return;
  persist(
    {
      v: SCHEMA_VERSION,
      conversations: state.conversations,
      folders: [],
      activeId: state.activeId,
    },
    localStorage,
  );
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', flushPersistNow);
  window.addEventListener('pagehide', flushPersistNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPersistNow();
  });
}

// ------------------------------------------------------------- selectors

export function useActiveConversation(): Conversation | null {
  return useStore(
    (state) =>
      state.conversations.find((conversation) => conversation.id === state.activeId) ?? null,
  );
}

/**
 * The visible transcript.
 *
 * `useShallow` so a store change that does not alter the path — a status poll,
 * a notice, a settings tweak — does not re-render the whole transcript.
 */
export function useActivePath(): MessageNode[] {
  return useStore(
    useShallow((state) => {
      const conversation = state.conversations.find((c) => c.id === state.activeId);
      if (!conversation) return [];
      return activePath(conversation.nodes, conversation.activeLeafId, conversation.branchChoices);
    }),
  );
}

/** The turns to send, stripped to what the wire accepts. */
export function wireTurns(
  path: MessageNode[],
  system: string,
): Array<{ role: Role; content: string }> {
  const turns = path
    // A failed turn is not history the model should continue from.
    .filter((node) => node.status !== 'failed' && node.content !== '')
    .map((node) => ({ role: node.role, content: node.content }));

  return system.trim() === '' ? turns : [{ role: 'system', content: system }, ...turns];
}
