import { useEffect, useMemo, useState } from 'react';
import { Archive, MessageSquare, Pin, SquarePen } from 'lucide-react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { groupConversations, searchConversations } from '@/chat/ConversationSearch';
import { formatRelativeTime } from '@/lib/format';
import { useStore } from '@/state/store';
import { useMidnightTick } from '@/lib/useMidnightTick';

/**
 * Global conversation search, opened with the sidebar's magnifier or ⌘K.
 *
 * Replaces the always-on search field and Archived toggle that used to sit in
 * the sidebar. Those cost two permanent controls at the top of a 260px rail
 * for something used occasionally, and the toggle in particular was a mode:
 * the list silently stopped showing active conversations until you noticed
 * and switched back.
 *
 * Ported from the Mac app's `ConversationSearchView`. Two behaviours come
 * with it and are the reason the toggle is not needed:
 *
 *   - **Archived conversations are included**, marked with a box icon rather
 *     than hidden behind a mode. Search is their recovery path.
 *   - **Every branch is searched**, not just the visible path — see
 *     `chat/ConversationSearch.ts`.
 */
export function SearchPalette({
  open,
  onOpenChange,
  onNewChat,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onNewChat(): void;
}) {
  const conversations = useStore((state) => state.conversations);
  const setActive = useStore((state) => state.setActiveConversation);
  const [query, setQuery] = useState('');
  const now = useMidnightTick();

  const sections = useMemo(
    () => groupConversations(searchConversations(conversations, query), now),
    [conversations, query, now],
  );

  return (
    <CommandDialog
      open={open}
      // Cleared here rather than in an effect on `open`: a stale query would
      // make the palette reopen onto the previous search's results, and doing
      // it in the handler avoids a second render pass to undo the first.
      onOpenChange={(next) => {
        if (!next) setQuery('');
        onOpenChange(next);
      }}
      title="Search conversations"
      description="Find a conversation by title or by anything said in it."
      className="top-[12%] translate-y-0 sm:max-w-lg"
      showCloseButton={false}
      // cmdk filters by item text by default. Ours is already filtered — and
      // by message bodies, which are not in the item — so its filter would
      // throw away rows that matched on content.
      shouldFilter={false}
    >
      <CommandInput
        placeholder="Search conversations"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList className="max-h-[min(60dvh,420px)]">
        <CommandEmpty>
          {conversations.length === 0 ? 'No conversations yet.' : 'Nothing matches.'}
        </CommandEmpty>

        {/* Offered first, and only with no query: a blank palette is often
            opened to start something rather than to find something. */}
        {query.trim() === '' ? (
          <CommandGroup>
            <CommandItem
              value="__new-chat"
              onSelect={() => {
                onNewChat();
                onOpenChange(false);
              }}
            >
              <SquarePen />
              New chat
            </CommandItem>
          </CommandGroup>
        ) : null}

        {sections.map((section) => (
          <CommandGroup key={section.label} heading={section.label}>
            {section.rows.map((conversation) => (
              <CommandItem
                key={conversation.id}
                value={conversation.id}
                onSelect={() => {
                  setActive(conversation.id);
                  onOpenChange(false);
                }}
              >
                {conversation.isArchived ? <Archive /> : <MessageSquare />}
                <span className="min-w-0 flex-1 truncate">
                  {conversation.title.trim() === '' ? 'New chat' : conversation.title}
                </span>
                {conversation.isPinned ? (
                  <Pin className="size-3 shrink-0" aria-label="Pinned" />
                ) : null}
                <span className="text-muted-foreground shrink-0 text-xs">
                  {formatRelativeTime(conversation.updatedAt, now)}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}

/** Bind ⌘K / Ctrl+K to open the palette. */
export function useSearchShortcut(onOpen: () => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'k' || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      onOpen();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onOpen]);
}
