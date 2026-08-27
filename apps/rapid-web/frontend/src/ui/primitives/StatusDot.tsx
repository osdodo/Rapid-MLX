import type { StatusRole } from '../../readiness/ModelReadiness';
import { cn } from '../../lib/cn';

const ROLE_FILL: Record<StatusRole, string> = {
  idle: 'bg-faint',
  ready: 'bg-green shadow-[0_0_0_3px_color-mix(in_srgb,var(--green)_18%,transparent)]',
  working: 'bg-amber',
  error: 'bg-danger',
};

/** The engine status dot. Pulses only while something is actually happening. */
export function StatusDot({
  role,
  pulse,
  className,
}: {
  role: StatusRole;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'size-[7px] shrink-0 rounded-full',
        ROLE_FILL[role],
        pulse && 'animate-[status-pulse_1.4s_ease-in-out_infinite]',
        className,
      )}
      aria-hidden="true"
    />
  );
}
