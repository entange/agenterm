import * as React from 'react';
import { cn } from './utils.js';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: 'primary' | 'quiet' | 'danger';
}

const toneClasses: Record<NonNullable<ButtonProps['tone']>, string> = {
  primary: 'bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900',
  quiet: 'bg-transparent text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800',
  danger: 'bg-red-600 text-white hover:bg-red-500'
};

/** Shared button used across dashboard, discover, and detail screens. */
export function Button({ tone = 'primary', className, ...rest }: ButtonProps): React.JSX.Element {
  return (
    <button
      className={cn(
        'inline-flex h-8 items-center gap-2 rounded-md px-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-sky-500 disabled:opacity-50',
        toneClasses[tone],
        className
      )}
      {...rest}
    />
  );
}
