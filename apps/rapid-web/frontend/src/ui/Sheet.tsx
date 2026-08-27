import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Button } from './primitives/Button';

/**
 * A modal sheet. Bottom sheet on a phone (thumb reach), centred dialog above
 * the 640px breakpoint.
 *
 * Radix supplies the focus trap, Escape handling and `aria-modal`. The old
 * page's sheets were divs toggled by a `hidden` class, so content behind them
 * stayed reachable and Escape closed all of them at once.
 */

export interface SheetProps {
  open: boolean;
  onClose(): void;
  title: string;
  /** Rendered in the header, right of the title. */
  actions?: ReactNode;
  children: ReactNode;
}

export function Sheet({ open, onClose, title, actions, children }: SheetProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="bg-fg/20 fixed inset-0 z-20 flex animate-[fade-in_0.18s_var(--ease)_both] flex-col justify-end backdrop-blur-[2px] sm:items-center sm:justify-center sm:p-6" />
        <DialogPrimitive.Content
          className={cn(
            'bg-canvas shadow-lg fixed inset-x-0 bottom-0 z-20 flex max-h-[88dvh] animate-[sheet-rise_0.26s_var(--ease)_both] flex-col rounded-t-lg',
            'sm:inset-auto sm:top-1/2 sm:left-1/2 sm:max-h-[min(70dvh,640px)] sm:w-[min(560px,100%-48px)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg',
          )}
          aria-label={title}
        >
          <header className="border-line-soft flex shrink-0 items-center gap-2 border-b py-3 pr-3.5 pl-4.5">
            <DialogPrimitive.Title className="font-display m-0 min-w-0 flex-1 text-[17px] font-semibold tracking-[-0.01em]">
              {title}
            </DialogPrimitive.Title>
            <div className="flex shrink-0 items-center gap-1">
              {actions}
              <DialogPrimitive.Close asChild>
                <Button variant="quiet" size="sm">
                  Done
                </Button>
              </DialogPrimitive.Close>
            </div>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
            {children}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
