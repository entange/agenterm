import * as React from 'react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge class lists with Tailwind conflict resolution. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(...inputs));
}

/** Status dot color for lifecycle truth. */
export function lifecycleColor(lifecycle: string): string {
  if (lifecycle === 'running' || lifecycle === 'starting') return 'bg-emerald-500';
  if (lifecycle === 'exited') return 'bg-zinc-400';
  if (lifecycle === 'killed' || lifecycle === 'crashed') return 'bg-red-500';
  return 'bg-amber-400';
}

/** Overlay chip color for best-effort harness state. */
export function overlayColor(overlay: string): string {
  if (overlay === 'working') return 'bg-sky-500';
  if (overlay === 'waiting_permission') return 'bg-amber-500';
  if (overlay === 'waiting_input') return 'bg-violet-500';
  if (overlay === 'completed') return 'bg-emerald-600';
  if (overlay === 'failed') return 'bg-red-600';
  return 'bg-zinc-500';
}

export const UiVersion = '0.1.0';

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
