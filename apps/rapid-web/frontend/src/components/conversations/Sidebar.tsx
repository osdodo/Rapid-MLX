import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useEffect, useState, type ReactNode } from 'react';
import { PanelLeft, Plus, Search, Settings as SettingsIcon, X } from 'lucide-react';
import { ConversationList } from './ConversationList';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { DialogOverlay, DialogPortal } from '@/components/ui/dialog';
import { Wordmark } from '@/components/common/Wordmark';

/**
 * The persistent left rail and its narrow-screen counterpart.
 *
 * They are separate elements, not one repositioned: above the breakpoint the
 * rail sits BESIDE the transcript and must be a landmark (no focus trap, no
 * Escape, content beside it reachable). Below it, the drawer overlays the
 * transcript and must be a real modal.
 */

export interface SidebarProps {
  /** Rendered at the top of the rail — the model selector lives here. */
  header: ReactNode;
  onNewChat(): void;
  onOpenSettings(): void;
  onSearch(): void;
  collapsed: boolean;
  onToggleCollapsed(): void;
}

export function Sidebar({
  header,
  onNewChat,
  onOpenSettings,
  onSearch,
  collapsed,
  onToggleCollapsed,
}: SidebarProps) {
  return (
    <aside
      className={cn(
        'bg-sidebar text-sidebar-foreground border-sidebar-border flex h-dvh shrink-0 flex-col overflow-hidden border-r transition-[width] duration-200',
        collapsed ? 'w-0 border-r-0' : 'w-[260px]',
      )}
      // A landmark, not a dialog: a screen reader user can jump here and back
      // out without anything being trapped.
      aria-label="Conversations"
    >
      <SidebarTop
        onDismiss={onToggleCollapsed}
        dismissLabel="Collapse sidebar"
        icon={<PanelLeft />}
        onSearch={onSearch}
      />
      {header}
      <NewChatButton onClick={onNewChat} />
      <ListRegion>
        <ConversationList />
      </ListRegion>
      <SidebarFooter onOpenSettings={onOpenSettings} />
    </aside>
  );
}

export function SidebarDrawer({
  open,
  onClose,
  header,
  onNewChat,
  onOpenSettings,
  onSearch,
}: {
  open: boolean;
  onClose(): void;
  header: ReactNode;
  onNewChat(): void;
  onOpenSettings(): void;
  onSearch(): void;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogPortal>
        <DialogOverlay className="z-20" />
        <DialogPrimitive.Content
          className="bg-sidebar text-sidebar-foreground border-sidebar-border data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left fixed inset-y-0 left-0 z-20 flex h-dvh w-[min(300px,86vw)] flex-col border-r shadow-lg transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500"
          aria-label="Conversations"
        >
          <DialogPrimitive.Title className="sr-only">Conversations</DialogPrimitive.Title>
          <SidebarTop
            onDismiss={onClose}
            dismissLabel="Close sidebar"
            icon={<X />}
            // Sequenced, not simultaneous. Both are Radix modals, and
            // dismissing this one in the same tick as opening the palette
            // makes the drawer's exit reclaim focus and close it again —
            // the palette flashes and vanishes. Waiting for the close
            // animation to finish lets the palette take focus cleanly.
            onSearch={() => {
              onClose();
              setTimeout(onSearch, 320);
            }}
          />
          {header}
          <NewChatButton
            onClick={() => {
              onNewChat();
              onClose();
            }}
          />
          <ListRegion>
            <ConversationList onNavigate={onClose} />
          </ListRegion>
          <SidebarFooter
            onOpenSettings={() => {
              onOpenSettings();
              onClose();
            }}
          />
        </DialogPrimitive.Content>
      </DialogPortal>
    </DialogPrimitive.Root>
  );
}

function SidebarTop({
  onDismiss,
  dismissLabel,
  icon,
  onSearch,
}: {
  onDismiss(): void;
  dismissLabel: string;
  icon: ReactNode;
  onSearch(): void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 pt-[calc(env(safe-area-inset-top)+12px)] pr-2.5 pb-2 pl-4">
      <Wordmark className="min-w-0 flex-1 text-lg" />
      {/* Search lives here rather than as a field in the list: a permanent
          input costs a row of a 260px rail for something used occasionally,
          and the Archived toggle beside it was a mode the list got stuck in.
          Same placement as the Mac app's toolbar magnifier. */}
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        onClick={onSearch}
        aria-label="Search conversations"
        title="Search conversations — ⌘K"
      >
        <Search />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        onClick={onDismiss}
        aria-label={dismissLabel}
        title={dismissLabel}
      >
        {icon}
      </Button>
    </div>
  );
}

function NewChatButton({ onClick }: { onClick(): void }) {
  return (
    <Button
      variant="outline"
      className="mx-3 mt-1 mb-2.5 w-[calc(100%-24px)] shrink-0 justify-start"
      onClick={onClick}
    >
      <Plus className="text-muted-foreground" />
      New chat
    </Button>
  );
}

/** The only thing that scrolls, so the header and footer stay put. */
function ListRegion({ children }: { children: ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>;
}

function SidebarFooter({ onOpenSettings }: { onOpenSettings(): void }) {
  return (
    <div className="border-sidebar-border shrink-0 border-t px-3 pt-2 pb-[calc(env(safe-area-inset-bottom)+10px)]">
      <Button
        variant="ghost"
        className="text-muted-foreground hover:text-foreground w-full justify-start"
        onClick={onOpenSettings}
      >
        <SettingsIcon />
        Settings
      </Button>
    </div>
  );
}

/**
 * Is the viewport wide enough for the rail to sit beside the transcript?
 *
 * 900px: the rail costs 260px and the transcript's reading measure is 720px.
 * `matchMedia` rather than a resize listener, so it fires once per crossing.
 */
export function useWideLayout(): boolean {
  const [wide, setWide] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 900px)').matches,
  );

  useEffect(() => {
    const query = window.matchMedia('(min-width: 900px)');
    const onChange = (event: MediaQueryListEvent) => setWide(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return wide;
}
