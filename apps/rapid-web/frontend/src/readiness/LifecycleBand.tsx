import {
  accessibilityLabel,
  actionIsRenderable,
  actionTitle,
  detail,
  headline,
  isWorking,
  progressFraction,
  readinessAction,
  statusRole,
  type ModelReadiness,
  type ReadinessAction,
} from './ModelReadiness';
import { cn } from '../lib/cn';
import { Button } from '../ui/primitives/Button';
import { StatusDot } from '../ui/primitives/StatusDot';

/**
 * The readiness surface above the composer.
 *
 * Every string comes from ModelReadiness — this component invents no copy of
 * its own. Two shapes: a graphite band while work is in flight, a quieter
 * banner otherwise.
 */

export interface LifecycleBandProps {
  readiness: ModelReadiness;
  /** Increments when a gated send is attempted. Flashes the band. */
  attentionToken: number;
  onAction(action: ReadinessAction): void;
}

export function LifecycleBand({ readiness, attentionToken, onAction }: LifecycleBandProps) {
  // Ready is the quiet state: nothing to say, nothing to do, no chrome.
  if (readiness.kind === 'ready') return null;

  const action = readinessAction(readiness);
  const fraction = progressFraction(readiness);
  const working = isWorking(readiness);
  const role = statusRole(readiness);
  const detailText = detail(readiness);

  return (
    <div
      className={cn(
        'relative mx-3 mb-2 flex animate-[band-flash_0.5s_var(--ease)] items-center gap-2.5 overflow-hidden rounded-md py-2.5 pr-2.5 pl-3 text-[13.5px]',
        working
          ? 'bg-band text-band-ink shadow-sm'
          : cn('bg-card border-line border', role === 'error' && 'border-danger/40'),
      )}
      // Re-keying restarts the flash, which is what makes a SECOND blocked
      // send visible.
      key={attentionToken}
      role="status"
      aria-label={accessibilityLabel(readiness)}
    >
      <StatusDot role={role} pulse={working} />

      <div className="flex min-w-0 flex-1 flex-col gap-px">
        {/* Not truncated: the model name lives here. */}
        <span className="font-medium [overflow-wrap:anywhere]">{headline(readiness)}</span>
        {/* Dropped first on a narrow screen — the composer placeholder already
            paraphrases it, whereas dropping the headline loses the model. */}
        {detailText ? (
          <span
            className={cn(
              'truncate text-[12.5px] max-[380px]:hidden',
              working ? 'text-band-ink-2' : 'text-muted',
            )}
          >
            {detailText}
          </span>
        ) : null}
      </div>

      {action && actionIsRenderable(action) ? (
        <Button variant="primary" size="sm" className="text-[13px]" onClick={() => onAction(action)}>
          {actionTitle(action)}
        </Button>
      ) : null}

      {/* Determinate ONLY when a real fraction exists: an indeterminate bar
          would imply a precision the byte monitor does not have. */}
      {fraction !== null ? (
        <div className="bg-band-track absolute inset-x-0 bottom-0 h-0.5">
          <div
            className="bg-amber h-full transition-[width] duration-300"
            style={{ width: percent(fraction) }}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Clamp BEFORE rounding: the byte monitor overshoots on the final chunk, so
 * an unclamped fraction renders as "101%".
 */
export function percent(fraction: number): string {
  const clamped = Math.min(1, Math.max(0, fraction));
  return `${Math.round(clamped * 100)}%`;
}
