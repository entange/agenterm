import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn } from './utils.js';

/**
 * Modal dialog with focus trap, Escape to close, and labelled title.
 * Body content and footer actions are passed as children.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  width = 'md',
  children
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  width?: 'sm' | 'md' | 'lg';
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/45 backdrop-blur-[2px]" />
        <DialogPrimitive.Content
          className={cn(
            'fixed top-[14vh] left-1/2 z-50 -translate-x-1/2 rounded-xl border border-line-strong bg-panel shadow-2xl outline-none',
            width === 'sm' ? 'w-[420px]' : width === 'md' ? 'w-[540px]' : 'w-[720px]'
          )}
        >
          <div className="border-b border-line px-5 pt-4 pb-3">
            <DialogPrimitive.Title className="text-[15px] font-semibold text-ink">{title}</DialogPrimitive.Title>
            {description === undefined ? (
              <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
            ) : (
              <DialogPrimitive.Description className="mt-1 text-[12.5px] text-ink-muted">{description}</DialogPrimitive.Description>
            )}
          </div>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** Dialog body padding. */
export function DialogBody({ children, className }: { children: React.ReactNode; className?: string }): React.JSX.Element {
  return <div className={cn('px-5 py-4', className)}>{children}</div>;
}

/** Right-aligned footer for dialog actions. */
export function DialogFooter({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{children}</div>;
}
