import { cn, IconButton } from '@agenterm/ui';
import { Copy } from 'lucide-react';
import * as React from 'react';
import { copyText } from '../lib/actions.js';

/** On/off switch with its label and an optional explanation. */
export function Switch({
  checked,
  onChange,
  label,
  detail,
  disabled = false
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  detail?: React.ReactNode;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <label className={cn('flex cursor-pointer items-start gap-3', disabled && 'cursor-default opacity-50')}>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] text-ink">{label}</span>
        {detail === undefined ? null : <span className="mt-0.5 block text-[12px] text-ink-muted">{detail}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 h-[18px] w-8 shrink-0 rounded-full border transition-colors',
          checked ? 'border-ink bg-ink' : 'border-line-strong bg-sunken'
        )}
      >
        <span
          className={cn(
            'absolute top-[2px] size-3 rounded-full transition-all',
            checked ? 'left-[16px] bg-canvas' : 'left-[2px] bg-ink-faint'
          )}
        />
      </button>
    </label>
  );
}

/** A row of mutually exclusive choices. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = 'md'
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  label: string;
  size?: 'sm' | 'md';
}): React.JSX.Element {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-line bg-sunken p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-[5px] transition-colors',
            size === 'sm' ? 'h-5 px-2 text-[11px]' : 'h-6 px-2.5 text-[12px]',
            option.value === value ? 'bg-raised text-ink shadow-sm' : 'text-ink-faint hover:text-ink-muted'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A command or snippet the user is meant to copy. */
export function CopyField({ text, label }: { text: string; label: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-1 rounded-md border border-line bg-sunken py-1 pr-1 pl-3">
      <code className="selectable min-w-0 flex-1 truncate font-mono text-[12px] text-ink">{text}</code>
      <IconButton label={`Copy ${label}`} onClick={() => copyText(text, label)}>
        <Copy className="size-3.5" />
      </IconButton>
    </div>
  );
}

/** A multi-line snippet the user is meant to copy, such as a config file entry. */
export function CopyBlock({
  text,
  label,
  wrap = false
}: {
  text: string;
  label: string;
  /** Wrap long lines, such as a command line, instead of scrolling them. */
  wrap?: boolean;
}): React.JSX.Element {
  return (
    <div className="relative rounded-md border border-line bg-sunken">
      <pre
        className={cn(
          'selectable scroll-thin py-2 pr-10 pl-3 font-mono text-[12px] leading-[1.6] text-ink',
          wrap ? 'break-all whitespace-pre-wrap' : 'overflow-x-auto'
        )}
      >
        {text}
      </pre>
      <IconButton label={`Copy ${label}`} onClick={() => copyText(text, label)} className="absolute top-1 right-1">
        <Copy className="size-3.5" />
      </IconButton>
    </div>
  );
}
