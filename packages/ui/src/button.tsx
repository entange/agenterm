import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from './utils.js';

export type ButtonTone = 'primary' | 'secondary' | 'quiet' | 'danger';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: ButtonTone;
  size?: 'sm' | 'md';
}

const tones: Record<ButtonTone, string> = {
  primary: 'bg-accent text-canvas hover:brightness-110 font-semibold',
  secondary: 'border border-line-strong bg-raised text-ink hover:border-ink-faint',
  quiet: 'text-ink-muted hover:bg-sunken hover:text-ink',
  danger: 'border border-fail/50 text-fail hover:bg-fail hover:text-canvas'
};

/** Text button. Labels name the action they perform. */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { tone = 'secondary', size = 'md', className, type = 'button', ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-45',
        size === 'sm' ? 'h-7 px-2.5 text-[12px]' : 'h-8 px-3 text-[13px]',
        tones[tone],
        className
      )}
      {...rest}
    />
  );
});

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name, also shown as the tooltip. */
  label: string;
  shortcut?: string;
  tone?: 'quiet' | 'danger';
}

/** Square icon button with a tooltip that doubles as its accessible name. */
export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, shortcut, tone = 'quiet', className, children, type = 'button', ...rest },
  ref
) {
  return (
    <Tooltip content={label} shortcut={shortcut}>
      <button
        ref={ref}
        type={type}
        aria-label={label}
        className={cn(
          'inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors disabled:pointer-events-none disabled:opacity-40',
          tone === 'danger'
            ? 'text-ink-muted hover:bg-fail/15 hover:text-fail'
            : 'text-ink-muted hover:bg-sunken hover:text-ink',
          className
        )}
        {...rest}
      >
        {children}
      </button>
    </Tooltip>
  );
});

/** Keycap for shortcut hints. */
export function Kbd({ children, className }: { children: React.ReactNode; className?: string }): React.JSX.Element {
  return (
    <kbd
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-line-strong bg-sunken px-1 font-mono text-[10px] leading-none text-ink-muted',
        className
      )}
    >
      {children}
    </kbd>
  );
}

export const TooltipProvider = TooltipPrimitive.Provider;

/** Small tooltip. Wrap exactly one focusable child. */
export function Tooltip({
  content,
  shortcut,
  side = 'bottom',
  children
}: {
  content: React.ReactNode;
  shortcut?: string | undefined;
  side?: 'top' | 'bottom' | 'left' | 'right';
  children: React.ReactElement;
}): React.JSX.Element {
  return (
    <TooltipPrimitive.Root delayDuration={350}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="z-50 flex items-center gap-2 rounded-md border border-line-strong bg-raised px-2 py-1 text-[12px] text-ink shadow-lg"
        >
          {content}
          {shortcut === undefined ? null : <Kbd>{shortcut}</Kbd>}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
