import { useEffect } from 'react';
import { useStore } from '../state/store';
import { cn } from '../lib/cn';
import { Button } from './primitives/Button';

/**
 * In-UI notices, replacing every `window.alert` in the old page.
 *
 * An alert steals focus, cannot be dismissed by tapping away, and on iOS can
 * arrive behind the keyboard.
 */
export function NoticeStack() {
  const notices = useStore((state) => state.notices);

  if (notices.length === 0) return null;

  return (
    // Below the header, not above the composer: the iOS keyboard would cover
    // a bottom notice exactly when most of these fire.
    <div className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+58px)] z-25 flex flex-col gap-2 px-3">
      {notices.map((notice) => (
        <NoticeRow key={notice.id} id={notice.id} />
      ))}
    </div>
  );
}

const TONE_RULE = {
  info: 'border-l-[3px] border-l-brand',
  warning: 'border-l-[3px] border-l-amber-deep',
  error: 'border-l-[3px] border-l-danger',
} as const;

function NoticeRow({ id }: { id: string }) {
  const notice = useStore((state) => state.notices.find((candidate) => candidate.id === id));
  const dismiss = useStore((state) => state.dismissNotice);

  useEffect(() => {
    // Only info expires on its own. A warning or error names something the
    // user has to act on; clearing it would hide a failure they never saw.
    if (notice?.tone !== 'info') return;
    const timer = setTimeout(() => dismiss(id), 6000);
    return () => clearTimeout(timer);
  }, [notice?.tone, dismiss, id]);

  if (!notice) return null;

  return (
    <div
      className={cn(
        'border-line bg-card shadow-md pointer-events-auto flex animate-[notice-drop_0.24s_var(--ease)_both] items-center gap-2.5 rounded-md border py-2.5 pr-2 pl-3 text-sm',
        TONE_RULE[notice.tone],
      )}
      // `alert` interrupts, `status` waits for a pause.
      role={notice.tone === 'error' ? 'alert' : 'status'}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="font-medium">{notice.title}</span>
        {notice.body ? <span className="text-muted text-[13px]">{notice.body}</span> : null}
      </div>
      {notice.action ? (
        <Button
          variant="quiet"
          size="sm"
          className="bg-brand-tint text-[13px]"
          onClick={() => {
            notice.action?.run();
            dismiss(notice.id);
          }}
        >
          {notice.action.label}
        </Button>
      ) : null}
      {/* 32px, not the 15px the glyph needs: a smaller dismiss target is a
          coin-toss with a thumb. */}
      <Button
        variant="icon"
        size="square"
        className="text-faint size-8 [&_svg]:size-[15px]"
        aria-label="Dismiss"
        onClick={() => dismiss(notice.id)}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </Button>
    </div>
  );
}
