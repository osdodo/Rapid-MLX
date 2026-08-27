import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useEffect, useState, type ReactNode } from 'react';
import { ConversationList } from './ConversationSheet';
import { cn } from '../lib/cn';
import { Button } from './primitives/Button';
import { Wordmark } from './primitives/Wordmark';

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
  collapsed: boolean;
  onToggleCollapsed(): void;
}

export function Sidebar({
  header,
  onNewChat,
  onOpenSettings,
  collapsed,
  onToggleCollapsed,
}: SidebarProps) {
  return (
    <aside
      className={cn(
        'border-line-soft flex h-dvh shrink-0 flex-col overflow-hidden border-r bg-[color-mix(in_srgb,var(--fg)_3%,var(--canvas))] transition-[width] duration-200',
        collapsed ? 'w-0 border-r-0' : 'w-[260px]',
      )}
      // A landmark, not a dialog: a screen reader user can jump here and back
      // out without anything being trapped.
      aria-label="Conversations"
    >
      <SidebarTop
        onDismiss={onToggleCollapsed}
        dismissLabel="Collapse sidebar"
        icon={<path d="M4 5h16M4 12h10M4 19h16" strokeLinecap="round" />}
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
}: {
  open: boolean;
  onClose(): void;
  header: ReactNode;
  onNewChat(): void;
  onOpenSettings(): void;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="bg-fg/20 fixed inset-0 z-20 animate-[fade-in_0.16s_var(--ease)_both] backdrop-blur-[2px]" />
        <DialogPrimitive.Content
          className="bg-canvas border-line shadow-lg fixed inset-y-0 left-0 z-20 flex h-dvh w-[min(300px,86vw)] animate-[drawer-slide_0.22s_var(--ease)_both] flex-col border-r"
          aria-label="Conversations"
        >
          <DialogPrimitive.Title className="sr-only">Conversations</DialogPrimitive.Title>
          <SidebarTop
            onDismiss={onClose}
            dismissLabel="Close sidebar"
            icon={<path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />}
            strokeWidth="2"
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
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function SidebarTop({
  onDismiss,
  dismissLabel,
  icon,
  strokeWidth = '1.7',
}: {
  onDismiss(): void;
  dismissLabel: string;
  icon: ReactNode;
  strokeWidth?: string;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 pt-[calc(env(safe-area-inset-top)+12px)] pr-2.5 pb-2 pl-4">
      <Wordmark className="min-w-0 flex-1 text-[18px]" />
      <Button
        variant="icon"
        size="square"
        className="size-8 [&_svg]:size-[17px]"
        onClick={onDismiss}
        aria-label={dismissLabel}
        title={dismissLabel}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} aria-hidden="true">
          {icon}
        </svg>
      </Button>
    </div>
  );
}

function NewChatButton({ onClick }: { onClick(): void }) {
  return (
    <button
      type="button"
      className="border-line bg-card shadow-sm hover:border-brand/45 active:scale-[0.99] mx-3 mt-1 mb-2.5 flex shrink-0 items-center gap-2 rounded-md border px-3 py-2.5 text-left text-sm font-medium [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-[var(--muted)]"
      onClick={onClick}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <path d="M12 5v14M5 12h14" strokeLinecap="round" />
      </svg>
      New chat
    </button>
  );
}

/** The only thing that scrolls, so the header and footer stay put. */
function ListRegion({ children }: { children: ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>;
}

function SidebarFooter({ onOpenSettings }: { onOpenSettings(): void }) {
  return (
    <div className="border-line-soft shrink-0 border-t px-3 pt-2 pb-[calc(env(safe-area-inset-bottom)+10px)]">
      <button
        type="button"
        className="text-muted hover:bg-line-soft hover:text-fg flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left text-[13.5px] [&_svg]:size-4 [&_svg]:shrink-0"
        onClick={onOpenSettings}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        Settings
      </button>
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
