import { isWorking, statusRole, type ModelReadiness } from '../readiness/ModelReadiness';
import { cn } from '../lib/cn';
import { StatusDot } from './primitives/StatusDot';

/**
 * The model selector, as a full-width row in the sidebar.
 *
 * Replaces the header chip, which could only carry a `title` — so in
 * `--attach` mode a phone user saw a greyed-out control with no explanation
 * and no hover to reveal one. The reason is now visible text.
 */

export interface ModelButtonProps {
  readiness: ModelReadiness;
  alias: string | null;
  /** False in --attach mode: the engine belongs to whoever started it. */
  canSwitch: boolean;
  onClick(): void;
}

export function ModelButton({ readiness, alias, canSwitch, onClick }: ModelButtonProps) {
  const role = statusRole(readiness);

  if (!canSwitch) {
    return (
      // Not a button: a disabled button invites a click and then refuses it.
      <div className="border-line mx-3 mb-1.5 rounded-md border border-dashed px-3 py-2.5">
        <div className="flex items-center gap-2.5">
          <StatusDot role={role} />
          <span className="text-[13.5px] font-medium [overflow-wrap:anywhere]">
            {alias ?? 'No model'}
          </span>
        </div>
        <p className="text-muted m-0 mt-[5px] text-[11.5px] leading-[1.45]">
          Attached to an engine this server does not own. Change the model from the terminal that
          started it.
        </p>
      </div>
    );
  }

  return (
    <button
      type="button"
      className="border-line bg-card shadow-sm hover:border-brand/45 active:scale-[0.99] mx-3 mb-1.5 flex w-[calc(100%-24px)] items-center gap-2.5 rounded-md border py-2.5 pr-2.5 pl-3 text-left transition-colors duration-200"
      onClick={onClick}
      aria-haspopup="dialog"
    >
      <StatusDot role={role} pulse={isWorking(readiness)} />
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        {/* No truncation: cutting "qwen3-0.6b-8bit" hides the quantisation. */}
        <span className="text-[13.5px] leading-[1.3] font-medium [overflow-wrap:anywhere]">
          {alias ?? 'Choose a model'}
        </span>
        <span
          className={cn(
            'text-[11.5px]',
            role === 'ready' ? 'text-green' : role === 'error' ? 'text-danger' : 'text-muted',
          )}
        >
          {shortState(readiness)}
        </span>
      </span>
      <svg
        className="text-faint size-3.5 shrink-0"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
      >
        <path d="m6 9 6 6 6-6" strokeLinecap="round" />
      </svg>
    </button>
  );
}

/**
 * A word or two for the row's second line. Terser than `headline` on purpose:
 * the banner above the composer carries the full sentence.
 */
function shortState(readiness: ModelReadiness): string {
  switch (readiness.kind) {
    case 'ready':
      return 'Ready';
    case 'starting':
      return 'Starting…';
    case 'downloading':
      return 'Downloading…';
    case 'needsDownload':
      return 'Not downloaded';
    case 'needsStart':
    case 'unknownModel':
      return 'Not running';
    case 'failed':
      return 'Failed';
    case 'serverUnreachable':
      return 'Disconnected';
    case 'noModel':
      return 'Tap to choose';
  }
}
