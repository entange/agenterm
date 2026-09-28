import * as React from 'react';
import { cn } from './utils.js';

/** Small pill for lifecycle truth plus harness overlay. */
export function StatusPill({ label, className }: { label: string; className?: string }): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center rounded-full px-2 text-[11px] font-semibold uppercase tracking-wide text-white',
        className
      )}
    >
      {label}
    </span>
  );
}

/** Empty state block for lists. */
export function EmptyState({ title, detail }: { title: string; detail: string }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-dashed border-zinc-300 p-6 text-center dark:border-zinc-700">
      <div className="text-sm font-semibold">{title}</div>
      <div className="mt-1 text-sm text-zinc-500">{detail}</div>
    </div>
  );
}
