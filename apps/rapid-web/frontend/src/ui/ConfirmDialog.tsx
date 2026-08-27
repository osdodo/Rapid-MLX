import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { Button } from './primitives/Button';

/**
 * Replaces `window.confirm`.
 *
 * The native dialog cannot say what the action will cost, and for deletion
 * here that is the point: a subtree spans branches not visible on screen.
 */
export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body?: string | undefined;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm(): void;
  onCancel(): void;
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  destructive,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialog.Portal>
        {/* z-40: raised FROM a sheet, so it must sit over it. */}
        <AlertDialog.Overlay className="bg-fg/30 fixed inset-0 z-40 animate-[fade-in_0.15s_var(--ease)_both]" />
        <AlertDialog.Content className="bg-card shadow-lg fixed top-1/2 left-1/2 z-40 w-[min(360px,100%-48px)] -translate-x-1/2 -translate-y-1/2 animate-[dialog-pop_0.18s_var(--ease)_both] rounded-lg p-4.5">
          <AlertDialog.Title className="m-0 mb-1.5 text-[15.5px] leading-[1.35] font-semibold">
            {title}
          </AlertDialog.Title>
          {body ? (
            <AlertDialog.Description className="text-muted m-0 mb-4 text-[13.5px]">
              {body}
            </AlertDialog.Description>
          ) : null}
          <div className="flex justify-end gap-2">
            {/* Cancel is focused first: a stray Return must not delete. */}
            <AlertDialog.Cancel asChild>
              <Button variant="ghost" size="md">
                Cancel
              </Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button variant={destructive ? 'danger' : 'primary'} size="md" onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
