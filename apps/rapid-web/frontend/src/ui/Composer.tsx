import { useEffect, useRef, useState } from 'react';
import { cn } from '../lib/cn';

export interface ComposerProps {
  placeholder: string;
  sendTooltip: string;
  canSend: boolean;
  streaming: boolean;
  onSend(text: string): void;
  onStop(): void;
  /** Called when Return is pressed while sending is gated. */
  onBlocked(): void;
}

export function Composer({
  placeholder,
  sendTooltip,
  canSend,
  streaming,
  onSend,
  onStop,
  onBlocked,
}: ComposerProps) {
  const [draft, setDraft] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);

  // Recomputed rather than tracked: a paste can add many lines at once.
  useEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, window.innerHeight * 0.34)}px`;
  }, [draft]);

  const submit = () => {
    const text = draft.trim();
    if (text === '') return;

    if (!canSend) {
      // The draft is NOT consumed — clearing the field would throw away what
      // the user typed for a condition they cannot see.
      onBlocked();
      return;
    }

    setDraft('');
    onSend(text);
  };

  const idle = !streaming && draft.trim() === '';

  return (
    <footer className="border-line-soft bg-canvas/85 relative z-2 shrink-0 border-t px-3 pt-2 pb-[calc(env(safe-area-inset-bottom)+10px)] backdrop-blur-xl backdrop-saturate-150">
      <div className="border-line bg-card shadow-sm focus-within:border-brand/55 flex items-end gap-2 rounded-[22px] border py-[5px] pr-[5px] pl-3.5 transition-colors duration-200">
        <textarea
          ref={field}
          className="placeholder:text-faint max-h-[34vh] min-w-0 flex-1 resize-none border-none bg-transparent py-2 leading-[1.45] outline-none"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            // Plain Return inserts a newline on a phone, where it is the only
            // way to type one. Cmd/Ctrl+Return sends.
            if (!event.metaKey && !event.ctrlKey) return;
            event.preventDefault();
            submit();
          }}
          placeholder={placeholder}
          rows={1}
          autoCapitalize="sentences"
          aria-label="Message"
        />

        <button
          type="button"
          className={cn(
            'inline-flex size-[34px] shrink-0 items-center justify-center rounded-full transition-[background-color,transform] duration-150 [&_svg]:size-[17px]',
            'active:not-disabled:scale-[0.93]',
            streaming ? 'bg-line-soft text-fg' : 'bg-amber text-[#241a08]',
            // An outline, never a dead grey fill: "nothing to send yet" must
            // not read as "broken".
            'disabled:border-line disabled:text-faint disabled:cursor-default disabled:border disabled:bg-transparent',
          )}
          onClick={streaming ? onStop : submit}
          // Never disabled while gated: a disabled button cannot explain
          // itself. Disabled only with nothing to send.
          disabled={idle}
          title={streaming ? 'Stop' : sendTooltip}
          aria-label={streaming ? 'Stop generating' : 'Send'}
        >
          {streaming ? (
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <rect x="7" y="7" width="10" height="10" rx="1.5" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          )}
        </button>
      </div>
    </footer>
  );
}
