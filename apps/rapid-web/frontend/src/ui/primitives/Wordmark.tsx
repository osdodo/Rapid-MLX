import { cn } from '../../lib/cn';

/** The Rapid-MLX wordmark. `-MLX` is a superscript mono tag on the brand colour. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('font-display font-semibold tracking-[-0.02em]', className)}>
      Rapid
      <span className="font-mono text-brand align-super text-[0.43em] font-semibold tracking-[0.1em] uppercase">
        -MLX
      </span>
    </span>
  );
}
