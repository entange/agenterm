import * as React from 'react';
import { cn, signalBg, type Signal } from './utils.js';

/** Status dot. `pulse` is reserved for signals that need the user. */
export function SignalDot({ signal, pulse = false, className }: { signal: Signal; pulse?: boolean; className?: string }): React.JSX.Element {
  return <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', signalBg[signal], pulse && 'attn-breathe', className)} />;
}

/** Spinner for in-flight loads. */
export function Spinner({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn('inline-block size-3.5 animate-spin rounded-full border-2 border-line-strong border-t-accent', className)}
    />
  );
}

/**
 * Empty or error state. The title says what is true; the detail says
 * what to do next; the action, when present, does it.
 */
export function EmptyState({
  title,
  detail,
  action,
  icon,
  className
}: {
  title: string;
  detail?: React.ReactNode;
  action?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-6 py-10 text-center', className)}>
      {icon === undefined ? null : <div className="mb-1 text-ink-faint">{icon}</div>}
      <div className="text-[13.5px] font-medium text-ink">{title}</div>
      {detail === undefined ? null : <div className="max-w-sm text-[12.5px] text-ink-muted">{detail}</div>}
      {action === undefined ? null : <div className="mt-2">{action}</div>}
    </div>
  );
}
