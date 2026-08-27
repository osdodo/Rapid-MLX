import { cn } from '@/lib/utils';

/** The Rapid-MLX wordmark. `-MLX` is a superscript mono tag. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('font-semibold tracking-tight', className)}>
      Rapid
      <span className="font-mono text-muted-foreground align-super text-[0.43em] font-semibold tracking-[0.1em] uppercase">
        -MLX
      </span>
    </span>
  );
}
