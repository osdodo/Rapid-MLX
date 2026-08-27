import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Blocks } from '../markdown/Blocks';
import { parseMarkdown, tokensOf } from '../markdown/lex';
import { streamingStore } from '../chat/StreamingStore';
import { copyText } from '../lib/clipboard';
import { cn } from '../lib/cn';
import { formatDuration, formatTokensPerSecond } from '../lib/format';
import type { MessageNode } from '../state/types';
import { Button } from './primitives/Button';

export interface MessageRowProps {
  node: MessageNode;
  mathRendering: 'mathml' | 'source';
  /** Position within its sibling group, when there is more than one. */
  branch: { index: number; total: number } | null;
  onBranch(direction: -1 | 1): void;
  onRetry(): void;
  onEdit(content: string): void;
  onDelete(): void;
  /** Blocks every action: the in-flight turn writes to a specific node id,
   *  and swapping the tree under it lands tokens in the wrong branch. */
  busy: boolean;
}

export const MessageRow = memo(function MessageRow(props: MessageRowProps) {
  const { node } = props;
  if (node.role === 'user') return <UserRow {...props} />;
  return <AssistantRow {...props} />;
});

function UserRow({ node, onEdit, onDelete, busy }: MessageRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(node.content);

  if (editing) {
    return (
      <div className={cn('flex flex-col animate-[row-rise_0.32s_var(--ease)_both] group', 'items-end')}>
        <div className="flex w-full max-w-[84%] flex-col gap-1.5">
          <textarea
            className="border-brand bg-card w-full resize-none rounded-md border px-3 py-2.5 leading-normal"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={Math.min(10, draft.split('\n').length + 1)}
            aria-label="Edit message"
            autoFocus
          />
          <div className="flex justify-end gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="text-muted text-[13px]"
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              className="text-[13px] font-medium"
              disabled={draft.trim() === '' || draft === node.content}
              onClick={() => {
                setEditing(false);
                onEdit(draft.trim());
              }}
            >
              Send
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col animate-[row-rise_0.32s_var(--ease)_both] group', 'items-end')}>
      {/* Plain text, never markdown: this is what the user typed, and
          rendering it would change what they see from what they wrote. */}
      <div className="text-on-brand shadow-sm max-w-[84%] rounded-lg rounded-br-[6px] px-4 py-2.5 [overflow-wrap:anywhere] whitespace-pre-wrap bg-[linear-gradient(160deg,var(--brand)_0%,color-mix(in_srgb,var(--brand)_84%,var(--canvas))_100%)]">{node.content}</div>
      <MessageActions>
        <CopyButton text={node.content} />
        <ActionButton
          label="Edit"
          onClick={() => {
            setDraft(node.content);
            setEditing(true);
          }}
          disabled={busy}
        />
        <ActionButton label="Delete" onClick={onDelete} disabled={busy} />
      </MessageActions>
    </div>
  );
}

function AssistantRow({
  node,
  mathRendering,
  branch,
  onBranch,
  onRetry,
  onDelete,
  busy,
}: MessageRowProps) {
  const streaming = node.status === 'streaming';

  return (
    <div className={cn('flex flex-col animate-[row-rise_0.32s_var(--ease)_both] group', 'items-start')}>
      <div className="font-display max-w-full text-[16.5px] leading-[1.62]">
        {streaming ? (
          <StreamingBody mathRendering={mathRendering} />
        ) : (
          <SettledBody node={node} mathRendering={mathRendering} />
        )}
      </div>

      {node.status === 'failed' && node.error ? (
        <div className="font-body border-danger/32 mt-1.5 rounded-md border bg-[color-mix(in_srgb,var(--danger)_7%,var(--card))] px-3 py-2 text-sm" role="alert">
          {node.error.message}
        </div>
      ) : null}

      {!streaming ? (
        <MessageActions>
          {branch && branch.total > 1 ? (
            <span className="mr-1 inline-flex items-center gap-px">
              <button
                type="button"
                className="text-muted hover:not-disabled:bg-line-soft hover:not-disabled:text-fg disabled:opacity-35 disabled:cursor-default size-[22px] rounded-sm text-[15px] leading-none"
                // Bounded, not wrapping: the disabled state then matches what
                // the control actually does at each end.
                disabled={branch.index === 0 || busy}
                onClick={() => onBranch(-1)}
                aria-label="Previous version"
              >
                ‹
              </button>
              <span
                className="font-mono text-faint min-w-[26px] text-center text-[11px]"
                aria-label={`Version ${branch.index + 1} of ${branch.total}`}
              >
                {branch.index + 1}/{branch.total}
              </span>
              <button
                type="button"
                className="text-muted hover:not-disabled:bg-line-soft hover:not-disabled:text-fg disabled:opacity-35 disabled:cursor-default size-[22px] rounded-sm text-[15px] leading-none"
                disabled={branch.index === branch.total - 1 || busy}
                onClick={() => onBranch(1)}
                aria-label="Next version"
              >
                ›
              </button>
            </span>
          ) : null}
          <CopyButton text={node.content} />
          <ActionButton label="Retry" onClick={onRetry} disabled={busy} />
          <ActionButton label="Delete" onClick={onDelete} disabled={busy} />
        </MessageActions>
      ) : null}

      {node.stats && !streaming ? <Stats stats={node.stats} /> : null}
    </div>
  );
}

/** The settled renderer. Tokens are parsed once, on the final content. */
function SettledBody({
  node,
  mathRendering,
}: {
  node: MessageNode;
  mathRendering: 'mathml' | 'source';
}) {
  const tokens = useMemoTokens(node.content);

  return (
    <>
      {node.reasoning ? <Reasoning text={node.reasoning} /> : null}
      {node.content === '' && node.status !== 'failed' ? (
        <p className="text-muted italic">(empty response)</p>
      ) : (
        <Blocks tokens={tokens} mathRendering={mathRendering} />
      )}
    </>
  );
}

/**
 * The streaming renderer.
 *
 * Subscribes to StreamingStore rather than to the app store, so a commit
 * re-renders this one row and nothing else. Tokens come from the incremental
 * lexer, so the blocks above the tail keep their identity and their DOM.
 */
function StreamingBody({ mathRendering }: { mathRendering: 'mathml' | 'source' }) {
  const snapshot = useSyncExternalStore(streamingStore.subscribe, streamingStore.getSnapshot);
  const tokens = tokensOf(snapshot.lex);

  return (
    <>
      {snapshot.reasoning ? <Reasoning text={snapshot.reasoning} defaultOpen /> : null}
      <Blocks tokens={tokens} streaming mathRendering={mathRendering} />
      <span className="bg-amber ml-px inline-block h-[1.05em] w-0.5 animate-[caret-blink_1s_steps(2,start)_infinite] align-text-bottom" aria-hidden="true" />
    </>
  );
}

/** A reasoning model's scratchpad. Collapsed by default once settled. */
function Reasoning({ text, defaultOpen }: { text: string; defaultOpen?: boolean }) {
  return (
    <details className="border-line mb-2.5 border-l-2 pl-2.5" open={defaultOpen}>
      <summary className="reasoning-summary font-body text-muted py-0.5 text-[12.5px]">Thinking</summary>
      {/* Plain text, not markdown: a scratchpad is not prose, and parsing it
          would spend the budget on something nobody reads twice. */}
      <div className="font-body text-muted pb-1 text-[13.5px] leading-normal whitespace-pre-wrap">{text}</div>
    </details>
  );
}

function Stats({ stats }: { stats: NonNullable<MessageNode['stats']> }) {
  const tps = formatTokensPerSecond(stats.tps);
  const ttft = formatDuration(stats.ttftMs);

  return (
    <div className="font-mono text-faint mt-0.5 flex flex-wrap gap-2.5 text-[11px]">
      {tps ? <span className="text-green">{tps}</span> : null}
      <span>
        {stats.tokens} tokens
        {/* Marked, because a count derived from content.length/4 is off by a
            wide and model-dependent margin and must not read as measured. */}
        {stats.tokensEstimated ? ' (est.)' : ''}
      </span>
      {ttft ? <span>{ttft} to first token</span> : null}
    </div>
  );
}

function MessageActions({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-body mt-[3px] flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
      {children}
    </div>
  );
}

function ActionButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick(): void;
  disabled?: boolean;
}) {
  return (
    <button type="button" className="text-muted hover:not-disabled:bg-line-soft hover:not-disabled:text-fg disabled:opacity-62 disabled:cursor-default rounded-sm px-2 py-1 text-xs" onClick={onClick} disabled={disabled}>
      {label}
    </button>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className="text-muted hover:not-disabled:bg-line-soft hover:not-disabled:text-fg disabled:opacity-62 disabled:cursor-default rounded-sm px-2 py-1 text-xs"
      onClick={() => {
        void copyText(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/** Parse once per distinct content string. */
function useMemoTokens(content: string) {
  const cache = useRef<{
    content: string;
    tokens: ReturnType<typeof parseMarkdown>;
  } | null>(null);
  if (cache.current?.content !== content) {
    cache.current = { content, tokens: parseMarkdown(content) };
  }
  return [...cache.current.tokens];
}

// -------------------------------------------------------------- transcript

export interface TranscriptProps {
  children: React.ReactNode;
  /** Bumped whenever new content lands, to drive the follow behaviour. */
  revision: number;
  streaming: boolean;
}

/**
 * The scrolling transcript.
 *
 * The old page called `scrollToBottom()` unconditionally on every paint
 * (index.html:1753) with `scroll-behavior: smooth` set, so reading back
 * during a stream was impossible — the view yanked itself down sixty times a
 * second, and each yank queued a smooth animation.
 */
export function Transcript({ children, revision, streaming }: TranscriptProps) {
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const onScroll = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    // 64px of slack: a user who is "at the bottom" is rarely at exactly zero,
    // and a strict test would drop follow on a one-pixel overscroll.
    const near = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
    atBottom.current = near;
    setShowJump(!near);
  }, []);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !atBottom.current) return;
    // Direct assignment, not scrollIntoView and not smooth: this fires on
    // every commit, and a queued animation per commit is what made the old
    // page unusable mid-answer.
    element.scrollTop = element.scrollHeight;
  }, [revision]);

  const jump = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
  }, []);

  return (
    <div className="relative z-1 min-h-0 flex-1">
      <div
        ref={ref}
        className="flex h-full flex-col gap-4.5 overflow-y-auto px-4 pt-5 pb-2"
        onScroll={onScroll}
        // `log` with live announcements OFF. A live transcript would have a
        // screen reader read every 90 ms commit; state changes are announced
        // through the dedicated region instead.
        role="log"
        aria-live="off"
        aria-label="Conversation"
      >
        {children}
      </div>

      {showJump ? (
        <button type="button" className="border-line bg-card text-fg shadow-md absolute bottom-3.5 left-1/2 inline-flex size-9 -translate-x-1/2 animate-[jump-pop_0.2s_var(--ease)_both] items-center justify-center rounded-full border [&_svg]:size-[17px]" onClick={jump} aria-label="Jump to latest">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M12 5v14M19 12l-7 7-7-7" />
          </svg>
          {/* The ring is the second signal: the arrow says there is content
              below, the ring says it is still arriving. */}
          {/* The arrow says there is content below; the ring says it is still arriving. */}
          {streaming ? <span className="border-amber absolute -inset-[3px] animate-spin rounded-full border-2 border-t-transparent" aria-hidden="true" /> : null}
        </button>
      ) : null}
    </div>
  );
}

/** Announces state changes only — never streamed tokens. */
export function LiveRegion({ message }: { message: string }) {
  const [announced, setAnnounced] = useState('');

  useEffect(() => {
    // A one-frame clear before re-announcing: an identical string assigned
    // twice is not re-read by most screen readers. The clear IS the point.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAnnounced('');
    const timer = setTimeout(() => setAnnounced(message), 60);
    return () => clearTimeout(timer);
  }, [message]);

  return (
    <div className="sr-only" role="status" aria-live="polite">
      {announced}
    </div>
  );
}
