import { useEffect, useMemo, useState } from 'react';
import { activePath } from '../chat/MessageTree';
import { dateGroupOf, formatRelativeTime, msUntilMidnight, type DateGroup } from '../lib/format';
import { useStore } from '../state/store';
import type { Conversation } from '../state/types';
import { ConfirmDialog } from './ConfirmDialog';
import { Sheet } from './Sheet';
import { cn } from '../lib/cn';

const GROUP_ORDER: DateGroup[] = [
  'Today',
  'Yesterday',
  'Previous 7 days',
  'Previous 30 days',
  'Older',
];

/**
 * The conversation list.
 *
 * Rendered in two places and deliberately ONE implementation: the persistent
 * sidebar on a wide screen, and the slide-out drawer below the layout
 * breakpoint. Two copies would drift — the search, the grouping and the
 * midnight ticker all have to behave identically or the narrow build quietly
 * becomes the worse one.
 *
 * `onNavigate` is what differs: the drawer closes itself after a selection,
 * the sidebar does not.
 */
export function ConversationList({ onNavigate }: { onNavigate?: () => void }) {
  const conversations = useStore((state) => state.conversations);
  const activeId = useStore((state) => state.activeId);
  const setActive = useStore((state) => state.setActiveConversation);
  const remove = useStore((state) => state.deleteConversation);

  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Conversation | null>(null);
  const now = useMidnightTick();

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    return conversations.filter((conversation) => {
      if (conversation.isArchived !== showArchived) return false;
      if (term === '') return true;
      // Search the bodies too: a user looking for "that shader thing" is more
      // likely to remember a phrase from the answer than the derived title.
      if (conversation.title.toLowerCase().includes(term)) return true;
      return conversation.nodes.some((node) => node.content.toLowerCase().includes(term));
    });
  }, [conversations, query, showArchived]);

  const grouped = useMemo(() => {
    const pinned = visible.filter((conversation) => conversation.isPinned);
    const rest = visible.filter((conversation) => !conversation.isPinned);

    const buckets = new Map<DateGroup, Conversation[]>();
    for (const conversation of rest) {
      const group = dateGroupOf(conversation.updatedAt, now);
      const list = buckets.get(group) ?? [];
      list.push(conversation);
      buckets.set(group, list);
    }

    const sections: Array<{ label: string; rows: Conversation[] }> = [];
    if (pinned.length > 0) sections.push({ label: 'Pinned', rows: byRecency(pinned) });
    for (const group of GROUP_ORDER) {
      const rows = buckets.get(group);
      if (rows?.length) sections.push({ label: group, rows: byRecency(rows) });
    }
    return sections;
  }, [visible, now]);

  return (
    <>
      <div className="sticky top-0 z-1 flex items-center gap-1.5 bg-inherit px-3 pt-1.5 pb-2">
        <label htmlFor="chat-search" className="sr-only">
          Search conversations
        </label>
        <input
          id="chat-search"
          type="search"
          className="border-line bg-card focus:border-brand min-w-0 flex-1 rounded-md border px-2.5 py-1.5 text-[13.5px]"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search conversations"
          autoCapitalize="off"
        />
        {/* Must LOOK like a toggle: as plain text it read as a section
            heading, matching the "Today" labels below it. */}
        <button
          type="button"
          className="border-line bg-card text-muted hover:text-fg aria-pressed:bg-brand-tint aria-pressed:border-brand/40 aria-pressed:text-brand shrink-0 rounded-sm border px-2.5 py-1.5 text-[11.5px] whitespace-nowrap"
          onClick={() => setShowArchived((value) => !value)}
          aria-pressed={showArchived}
        >
          {showArchived ? 'Active' : 'Archived'}
        </button>
      </div>

      <div className="px-2.5 pb-3">
        {grouped.length === 0 ? (
          <p className="text-muted m-0 px-3.5 py-6 text-center text-sm">
            {query
              ? 'Nothing matches.'
              : showArchived
                ? 'Nothing archived.'
                : 'No conversations yet.'}
          </p>
        ) : (
          grouped.map((section) => (
            <section key={section.label}>
              <h3 className="text-faint mt-3 mb-1 px-1.5 text-[11px] font-semibold tracking-[0.06em] uppercase">{section.label}</h3>
              {section.rows.map((conversation) => (
                <Row
                  key={conversation.id}
                  conversation={conversation}
                  current={conversation.id === activeId}
                  now={now}
                  onOpen={() => {
                    setActive(conversation.id);
                    onNavigate?.();
                  }}
                  onDelete={() => setPendingDelete(conversation)}
                />
              ))}
            </section>
          ))
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`Delete "${titleOf(pendingDelete)}"?`}
        body="This cannot be undone."
        confirmLabel="Delete"
        destructive
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) remove(pendingDelete.id);
          setPendingDelete(null);
        }}
      />
    </>
  );
}

/** The narrow-screen drawer. Wraps the same list in a modal sheet. */
export function ConversationSheet({ open, onClose }: { open: boolean; onClose(): void }) {
  return (
    <Sheet open={open} onClose={onClose} title="Conversations">
      <ConversationList onNavigate={onClose} />
    </Sheet>
  );
}

function Row({
  conversation,
  current,
  now,
  onOpen,
  onDelete,
}: {
  conversation: Conversation;
  current: boolean;
  now: number;
  onOpen(): void;
  onDelete(): void;
}) {
  const update = useStore((state) => state.updateConversation);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(conversation.title);

  const turns = activePath(
    conversation.nodes,
    conversation.activeLeafId,
    conversation.branchChoices,
  ).length;

  if (renaming) {
    return (
      <div className="flex items-center gap-1 rounded-md py-1 pr-1.5 pl-2.5">
        <input
          className="border-brand bg-card min-w-0 flex-1 rounded-sm border px-2.5 py-1.5 text-[14.5px]"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              // A rename is explicit, so it is marked custom and the
              // auto-derivation can never stomp it later.
              update(conversation.id, {
                title: draft.trim(),
                hasCustomTitle: draft.trim() !== '',
              });
              setRenaming(false);
            }
            if (event.key === 'Escape') {
              event.stopPropagation();
              setDraft(conversation.title);
              setRenaming(false);
            }
          }}
          onBlur={() => setRenaming(false)}
          aria-label="Conversation name"
          autoFocus
        />
      </div>
    );
  }

  return (
    // Neutral fill plus a 3px amber rule, not a tint: a 4-6% wash is
    // invisible on a phone in daylight.
    <div
      className={cn(
        'group hover:bg-line-soft flex items-center gap-1 rounded-md py-1 pr-1.5 pl-2.5',
        current && 'bg-line-soft shadow-[inset_3px_0_0_var(--amber-deep)]',
      )}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 flex-col gap-px py-1.5 text-left"
        onClick={onOpen}
      >
        <span className="truncate text-[14.5px]">{titleOf(conversation)}</span>
        <span className="text-muted text-xs">
          {turns} {turns === 1 ? 'message' : 'messages'} ·{' '}
          {formatRelativeTime(conversation.updatedAt, now)}
        </span>
      </button>

      {/* Hidden until hover on a pointer device; always shown on touch,
          where there is no hover and they would be unreachable. */}
      <div className="flex shrink-0 items-center gap-px opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
        <IconAction
          label={conversation.isPinned ? 'Unpin' : 'Pin'}
          active={conversation.isPinned}
          onClick={() => update(conversation.id, { isPinned: !conversation.isPinned })}
        >
          <path d="M12 17v5M9 3h6l-1 7 3 3H7l3-3z" />
        </IconAction>

        <IconAction
          label={conversation.isArchived ? 'Unarchive' : 'Archive'}
          onClick={() => update(conversation.id, { isArchived: !conversation.isArchived })}
        >
          <path d="M3 8h18v12H3zM3 4h18v4H3zM10 12h4" />
        </IconAction>

        <IconAction
          label="Rename"
          onClick={() => {
            setDraft(conversation.title);
            setRenaming(true);
          }}
        >
          <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
        </IconAction>

        <IconAction label="Delete" onClick={onDelete}>
          <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
        </IconAction>
      </div>
    </div>
  );
}

function IconAction({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      // 30px: below this a thumb misses between two adjacent actions.
      className={cn(
        'hover:bg-card hover:text-fg inline-flex size-[30px] items-center justify-center rounded-sm [&_svg]:size-[15px]',
        active ? 'text-amber-deep' : 'text-faint',
      )}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        aria-hidden="true"
      >
        {children}
      </svg>
    </button>
  );
}

function titleOf(conversation: Conversation | null): string {
  if (!conversation) return '';
  return conversation.title.trim() === '' ? 'New chat' : conversation.title;
}

function byRecency(rows: Conversation[]): Conversation[] {
  return [...rows].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Re-render when the local day rolls over.
 *
 * Without this an open tab keeps saying "Today" about yesterday's
 * conversations until something else happens to re-render — and the phone
 * that is left open overnight is the common case, not the rare one. The Mac
 * app's sidebar carries the same ticker.
 */
function useMidnightTick(): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // A one-second cushion, so the timer cannot fire a hair BEFORE midnight
    // and reschedule itself for a few milliseconds later in a tight loop.
    const timer = setTimeout(() => setNow(Date.now()), msUntilMidnight(now) + 1000);
    return () => clearTimeout(timer);
  }, [now]);

  return now;
}
