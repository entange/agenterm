import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge class lists with Tailwind conflict resolution. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(...inputs));
}

/** Signal names shared by dots, bands, and traces. Each maps to one meaning. */
export type Signal = 'attn' | 'work' | 'fail' | 'ok' | 'idle';

/** Text color class per signal. */
export const signalText: Record<Signal, string> = {
  attn: 'text-attn',
  work: 'text-work',
  fail: 'text-fail',
  ok: 'text-ok',
  idle: 'text-idle'
};

/** Background color class per signal. */
export const signalBg: Record<Signal, string> = {
  attn: 'bg-attn',
  work: 'bg-work',
  fail: 'bg-fail',
  ok: 'bg-ok',
  idle: 'bg-idle'
};
