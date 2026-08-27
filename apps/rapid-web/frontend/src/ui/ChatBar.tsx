import { Button } from './primitives/Button';

/**
 * The strip above the transcript.
 *
 * Near-empty on purpose: the rail already carries the wordmark, model
 * selector, New chat and Settings. Below the layout breakpoint the rail is
 * off screen, so the control that opens it lives here.
 */

export interface ChatBarProps {
  title: string;
  /** Null on a wide screen: the rail is already visible. */
  onOpenSidebar: (() => void) | null;
  onNewChat(): void;
}

export function ChatBar({ title, onOpenSidebar, onNewChat }: ChatBarProps) {
  return (
    <header className="border-line-soft bg-canvas/85 relative z-2 flex shrink-0 items-center gap-1.5 border-b px-3.5 pt-[calc(env(safe-area-inset-top)+10px)] pb-2.5 backdrop-blur-xl backdrop-saturate-150">
      {onOpenSidebar ? (
        <Button
          variant="icon"
          size="square"
          onClick={onOpenSidebar}
          aria-label="Open sidebar"
          title="Conversations"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
            <path d="M4 5h16M4 12h16M4 19h16" strokeLinecap="round" />
          </svg>
        </Button>
      ) : null}

      {/* Centred when flanked by buttons, left-aligned when alone. */}
      <h1
        className={`text-muted m-0 min-w-0 flex-1 truncate text-sm font-medium ${
          onOpenSidebar ? 'text-center' : 'text-left'
        }`}
      >
        {title}
      </h1>

      {onOpenSidebar ? (
        <Button variant="icon" size="square" onClick={onNewChat} aria-label="New chat" title="New chat">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="M12 5v14M5 12h14" strokeLinecap="round" />
          </svg>
        </Button>
      ) : null}
    </header>
  );
}
