import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { cn } from './utils.js';

/**
 * A panel anchored to its trigger, for details that belong to one control.
 * Escape or a click outside closes it.
 */
export function Popover({
  open,
  onOpenChange,
  trigger,
  label,
  align = 'end',
  className,
  children
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: React.ReactNode;
  /** Names the panel for assistive tech. */
  label: string;
  align?: 'start' | 'center' | 'end';
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          aria-label={label}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          className={cn('z-50 rounded-lg border border-line-strong bg-panel shadow-2xl outline-none', className)}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
