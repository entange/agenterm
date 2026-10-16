import { Button, cn, Popover, SignalDot, Spinner } from '@agenterm/ui';
import { ArrowDownToLine, ExternalLink, RotateCw } from 'lucide-react';
import * as React from 'react';
import type { ChangelogEntry, UpdateInfo, UpdateState } from '../../shared/update.js';
import { getBridge } from '../lib/bridge.js';
import { formatAge } from '../lib/format.js';
import { showUpdate, useUpdate } from '../lib/update.js';

/** How many changes the panel lists before pointing at GitHub for the rest. */
const SHOWN_CHANGES = 8;

/** `code` spans in a changelog line, set in mono. */
function Inline({ text }: { text: string }): React.JSX.Element {
  return (
    <>
      {text.split('`').map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="rounded bg-sunken px-1 font-mono text-[11.5px] text-ink">
            {part}
          </code>
        ) : (
          <React.Fragment key={i}>{part.replace(/\*\*/g, '')}</React.Fragment>
        )
      )}
    </>
  );
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** The versions since this one and what each changed, up to SHOWN_CHANGES lines. */
function Changes({ update }: { update: UpdateInfo }): React.JSX.Element {
  const open = (): void => void getBridge()?.openExternal(update.url);
  let budget = SHOWN_CHANGES;
  const shown: ChangelogEntry[] = [];
  for (const entry of update.entries) {
    if (budget <= 0) break;
    shown.push({ ...entry, changes: entry.changes.slice(0, budget) });
    budget -= Math.min(entry.changes.length, budget);
  }
  const total = update.entries.reduce((sum, entry) => sum + entry.changes.length, 0);
  const more = total - shown.reduce((sum, entry) => sum + entry.changes.length, 0);
  if (update.entries.length === 0) {
    return (
      <button
        type="button"
        onClick={open}
        className="flex items-center gap-1 text-[12.5px] text-ink-muted hover:text-ink"
      >
        See what changed on GitHub
        <ExternalLink className="size-3" />
      </button>
    );
  }
  return (
    <div className="space-y-3">
      {shown.map((entry) => (
        <section key={entry.version} className="space-y-1.5">
          <h3 className="flex items-baseline gap-2">
            <span className="font-mono text-[12px] font-semibold text-ink">{entry.version}</span>
            {entry.date === null ? null : <span className="text-[11px] text-ink-faint">{entry.date}</span>}
          </h3>
          <ul className="space-y-1">
            {entry.changes.map((change, i) => (
              <li key={i} className="flex gap-2 text-[12.5px] leading-snug text-ink-muted">
                <span className="mt-[7px] size-1 shrink-0 rounded-full bg-ink-faint" />
                <span className="min-w-0">
                  <Inline text={change} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {more > 0 ? (
        <button
          type="button"
          onClick={open}
          className="flex items-center gap-1 text-[12px] text-ink-muted hover:text-ink"
        >
          {more} more {more === 1 ? 'change' : 'changes'} on GitHub
          <ExternalLink className="size-3" />
        </button>
      ) : null}
    </div>
  );
}

function headline(state: UpdateState, current: string): { title: string; detail: string } {
  switch (state.kind) {
    case 'idle':
      return {
        title: 'agenterm is up to date',
        detail: `You have ${current}${state.checkedAtMs === null ? '' : `, checked ${formatAge(state.checkedAtMs, Date.now())} ago`}.`
      };
    case 'checking':
      return { title: 'Checking for updates…', detail: `You have ${current}.` };
    case 'available':
    case 'manual':
      return { title: `agenterm ${state.update.version} is available`, detail: `You have ${current}.` };
    case 'downloading':
      return { title: `Downloading ${state.update.version}…`, detail: `You have ${current}.` };
    case 'ready':
      return {
        title: `agenterm ${state.update.version} is ready`,
        detail: 'Restart to finish, or it goes in when you quit.'
      };
    case 'error':
      return { title: 'The update did not finish', detail: state.message };
  }
}

/** What to do next: download, watch it download, restart, or try again. */
function Footer({ state }: { state: UpdateState }): React.JSX.Element | null {
  const bridge = getBridge();
  switch (state.kind) {
    case 'available':
      return (
        <Button tone="primary" size="sm" onClick={() => void bridge?.downloadUpdate()}>
          <ArrowDownToLine className="size-3.5" />
          Download and install
        </Button>
      );
    case 'manual':
      return (
        <div className="space-y-2">
          <p className="text-[12px] text-ink-muted">{state.reason}</p>
          <Button size="sm" onClick={() => void bridge?.openExternal(state.update.url)}>
            <ExternalLink className="size-3.5" />
            Download from GitHub
          </Button>
        </div>
      );
    case 'downloading': {
      const share = state.totalBytes > 0 ? Math.min(1, state.receivedBytes / state.totalBytes) : 0;
      return (
        <div className="space-y-1.5">
          <div
            role="progressbar"
            aria-label="Download progress"
            aria-valuenow={Math.round(share * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-1 overflow-hidden rounded-full bg-sunken"
          >
            <div className="h-full bg-ink transition-[width] duration-150" style={{ width: `${share * 100}%` }} />
          </div>
          <p className="font-mono text-[11px] text-ink-faint">
            {megabytes(state.receivedBytes)} of {megabytes(state.totalBytes)}
          </p>
        </div>
      );
    }
    case 'ready':
      return (
        <Button tone="primary" size="sm" onClick={() => void bridge?.installUpdate()}>
          <RotateCw className="size-3.5" />
          Restart to update
        </Button>
      );
    case 'error':
      return (
        <Button
          size="sm"
          onClick={() => void (state.update === null ? bridge?.checkForUpdates() : bridge?.downloadUpdate())}
        >
          Try again
        </Button>
      );
    case 'idle':
      return (
        <Button size="sm" onClick={() => void bridge?.checkForUpdates()}>
          Check again
        </Button>
      );
    case 'checking':
      return null;
  }
}

/** Short label for the title bar button. */
function pill(state: UpdateState): { label: string; signal: 'ok' | 'idle' | null } | null {
  switch (state.kind) {
    case 'available':
    case 'manual':
      return { label: 'Update', signal: 'idle' };
    case 'downloading':
      return {
        label: `Updating ${state.totalBytes > 0 ? Math.floor((100 * state.receivedBytes) / state.totalBytes) : 0}%`,
        signal: null
      };
    case 'ready':
      return { label: 'Restart to update', signal: 'ok' };
    default:
      return null;
  }
}

/**
 * Title bar button that appears when a newer agenterm is out, with a panel
 * listing what changed and a way to install it.
 */
export function UpdateButton(): React.JSX.Element | null {
  const status = useUpdate((store) => store.status);
  const open = useUpdate((store) => store.open);
  const setOpen = useUpdate((store) => store.setOpen);
  if (status === null || !status.enabled) return null;
  const { state, current } = status;
  const shown = pill(state) ?? (open ? { label: 'Updates', signal: null } : null);
  if (shown === null) return null;
  const { title, detail } = headline(state, current);
  const update = 'update' in state ? state.update : null;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => (next ? showUpdate() : setOpen(false))}
      label="agenterm updates"
      className="w-[360px]"
      trigger={
        <button
          type="button"
          className={cn(
            'no-drag mr-1.5 inline-flex h-6 items-center gap-1.5 rounded-full border border-line-strong bg-raised px-2.5 text-[11.5px] text-ink-muted transition-colors hover:border-ink-faint hover:text-ink',
            open && 'border-ink-faint text-ink'
          )}
        >
          {state.kind === 'checking' || state.kind === 'downloading' ? (
            <Spinner className="size-3" />
          ) : shown.signal === null ? null : (
            <SignalDot signal={shown.signal} className="size-1.5" />
          )}
          {shown.label}
        </button>
      }
    >
      <div className="border-b border-line px-4 pt-3.5 pb-3">
        <p className="text-[13.5px] font-semibold text-ink">{title}</p>
        <p className={cn('mt-0.5 text-[12px]', state.kind === 'error' ? 'text-fail' : 'text-ink-faint')}>{detail}</p>
      </div>
      {update === null ? null : (
        <div className="scroll-thin max-h-[300px] overflow-y-auto px-4 py-3">
          <Changes update={update} />
        </div>
      )}
      <div className="flex flex-col gap-2 border-t border-line px-4 py-3">
        <Footer state={state} />
        {state.kind === 'available' || state.kind === 'ready' ? (
          <p className="text-[11.5px] text-ink-faint">Running tasks keep running.</p>
        ) : null}
      </div>
    </Popover>
  );
}
