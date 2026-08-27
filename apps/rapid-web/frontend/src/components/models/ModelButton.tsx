import { ChevronDown } from 'lucide-react';
import { isWorking, statusRole, type ModelReadiness } from '@/readiness/ModelReadiness';
import { cn } from '@/lib/utils';
import { StatusDot } from '@/components/common/StatusDot';

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
      <div className="mx-3 mb-1.5 rounded-lg border border-dashed px-3 py-2.5">
        <div className="flex items-center gap-2.5">
          <StatusDot role={role} />
          <span className="text-sm font-medium [overflow-wrap:anywhere]">
            {alias ?? 'No model'}
          </span>
        </div>
        <p className="text-muted-foreground m-0 mt-1 text-xs leading-relaxed">
          Attached to an engine this server does not own. Change the model from the terminal that
          started it.
        </p>
      </div>
    );
  }

  return (
    <button
      type="button"
      className="bg-background hover:bg-accent focus-visible:border-ring focus-visible:ring-ring/50 mx-3 mb-1.5 flex w-[calc(100%-24px)] items-center gap-2.5 rounded-lg border py-2.5 pr-2.5 pl-3 text-left shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px]"
      onClick={onClick}
      aria-haspopup="dialog"
    >
      <StatusDot role={role} pulse={isWorking(readiness)} />
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        {/* No truncation: cutting "qwen3-0.6b-8bit" hides the quantisation. */}
        <span className="text-sm leading-tight font-medium [overflow-wrap:anywhere]">
          {alias ?? 'Choose a model'}
        </span>
        <span
          className={cn(
            'text-xs',
            role === 'ready'
              ? 'text-success'
              : role === 'error'
                ? 'text-destructive'
                : 'text-muted-foreground',
          )}
        >
          {shortState(readiness)}
        </span>
      </span>
      <ChevronDown className="text-muted-foreground size-4 shrink-0" />
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
