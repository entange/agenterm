import type { OutsideProcess } from '@agenterm/core';
import { Button, cn, EmptyState, SignalDot, Tooltip } from '@agenterm/ui';
import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Skull, Square } from 'lucide-react';
import * as React from 'react';
import { stopOutside } from '../lib/actions.js';
import { getBridge } from '../lib/bridge.js';
import { formatAge, formatDuration, shortPath } from '../lib/format.js';
import { formatBytes, groupOutside, outsideLabel, runInstead } from '../lib/outside.js';
import { useUi } from '../lib/ui.js';
import { CopyBlock } from './controls.js';

function useClock(intervalMs: number): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * Sidebar list of commands running outside agenterm: orphans first,
 * then grouped by the terminal or agent that started them.
 */
export function OutsideList({
  processes,
  loading
}: {
  processes: OutsideProcess[];
  loading: boolean;
}): React.JSX.Element {
  const filter = useUi((state) => state.filter);
  const selectedPid = useUi((state) => state.selectedPid);
  const selectPid = useUi((state) => state.selectPid);
  const now = useClock(30_000);
  const groups = React.useMemo(() => groupOutside(processes, filter), [processes, filter]);
  const order = React.useMemo(() => groups.flatMap((group) => group.processes), [groups]);

  const onKey = (event: React.KeyboardEvent): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    if (order.length === 0) return;
    event.preventDefault();
    const at = order.findIndex((entry) => entry.pid === selectedPid);
    const next =
      order[at === -1 ? 0 : Math.min(order.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))];
    if (next !== undefined) selectPid(next.pid);
  };

  if (order.length === 0) {
    return (
      <p className="px-3 py-6 text-center text-[12px] text-ink-faint">
        {loading
          ? 'Looking…'
          : processes.length === 0
            ? 'Nothing is running outside agenterm.'
            : 'Nothing matches the filter.'}
      </p>
    );
  }

  return (
    <div
      role="listbox"
      aria-label="Commands outside agenterm"
      tabIndex={0}
      onKeyDown={onKey}
      className="scroll-thin min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 focus:outline-none"
    >
      {groups.map((group) => (
        <div key={group.key}>
          <div className="flex h-7 items-center gap-1.5 px-1.5 text-ink-muted">
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-[11.5px] font-semibold',
                group.key === 'orphaned' && 'text-attn'
              )}
            >
              {group.label}
            </span>
            <span className="font-mono text-[10.5px] text-ink-faint">{group.processes.length}</span>
          </div>
          {group.processes.map((entry) => (
            <OutsideRow
              key={entry.pid}
              entry={entry}
              now={now}
              selected={entry.pid === selectedPid}
              onSelect={() => selectPid(entry.pid)}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function OutsideRow({
  entry,
  now,
  selected,
  onSelect
}: {
  entry: OutsideProcess;
  now: number;
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      onClick={onSelect}
      title={`pid ${entry.pid} — ${entry.command}`}
      className={cn(
        'flex h-[46px] w-full flex-col justify-center gap-0.5 rounded-md px-2 text-left transition-colors',
        selected ? 'bg-accent-soft' : 'hover:bg-sunken/70'
      )}
    >
      <span className="flex w-full items-center gap-2">
        <SignalDot signal={entry.orphaned ? 'attn' : 'idle'} />
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{outsideLabel(entry)}</span>
        {entry.ports.length > 0 ? (
          <span className="shrink-0 font-mono text-[10.5px] text-ink-muted">:{entry.ports[0]}</span>
        ) : null}
        <span className="shrink-0 text-[10.5px] text-ink-faint">{formatAge(entry.startedAtMs, now)}</span>
      </span>
      <span className="block truncate pl-4 font-mono text-[11px] text-ink-faint">{entry.command}</span>
    </button>
  );
}

/** One command outside agenterm: what it is, where it came from, and a way to end it. */
export function OutsideView({ entry }: { entry: OutsideProcess }): React.JSX.Element {
  const client = useQueryClient();
  const now = useClock(1000);
  const rerun = runInstead(entry);

  const facts: Array<{ label: string; value: React.ReactNode }> = [
    {
      label: 'Started by',
      value: entry.orphaned ? (
        <span className="text-attn">nothing running: what started it has exited</span>
      ) : (
        `${entry.startedBy ?? 'unknown'}${entry.startedByPid === null ? '' : ` (pid ${entry.startedByPid})`}`
      )
    },
    {
      label: 'Folder',
      value:
        entry.cwd === null ? (
          'unknown'
        ) : (
          <button
            type="button"
            className="text-left hover:text-ink hover:underline"
            title={`Open ${entry.cwd}`}
            onClick={() => void getBridge()?.revealPath(entry.cwd ?? '')}
          >
            {shortPath(entry.cwd)}
          </button>
        )
    },
    { label: 'Running for', value: formatDuration(now - entry.startedAtMs) },
    {
      label: entry.pids.length === 1 ? 'Process' : 'Processes',
      value:
        entry.pids.length <= 8 ? entry.pids.join(' ') : `${entry.pids.slice(0, 8).join(' ')} +${entry.pids.length - 8}`
    },
    { label: 'CPU · memory', value: `${Math.round(entry.cpuPercent)}% · ${formatBytes(entry.memoryBytes)}` },
    ...(entry.tty === null ? [] : [{ label: 'Terminal', value: entry.tty }])
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-line bg-panel px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <SignalDot signal={entry.orphaned ? 'attn' : 'idle'} />
          <h1 className="min-w-0 truncate text-[14px] font-semibold text-ink">{outsideLabel(entry)}</h1>
          <span className={cn('shrink-0 text-[12px]', entry.orphaned ? 'text-attn' : 'text-ink-faint')}>
            {entry.orphaned ? 'orphaned' : `by ${entry.startedBy ?? 'unknown'}`}
          </span>
          {entry.ports.map((port) => (
            <Tooltip key={port} content={`Open http://localhost:${port}`}>
              <button
                type="button"
                onClick={() => void getBridge()?.openExternal(`http://localhost:${port}`)}
                className="inline-flex h-5 shrink-0 items-center gap-1 rounded border border-line-strong px-1.5 font-mono text-[11px] text-ink-muted hover:border-ink-faint hover:text-ink"
              >
                :{port}
                <ExternalLink className="size-3" />
              </button>
            </Tooltip>
          ))}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Tooltip content="SIGTERM, then SIGKILL if it keeps running">
              <Button size="sm" onClick={() => stopOutside(client, entry, false)}>
                <Square className="size-3" />
                Stop
              </Button>
            </Tooltip>
            <Tooltip content="End it and everything under it right now">
              <Button size="sm" tone="danger" onClick={() => stopOutside(client, entry, true)}>
                <Skull className="size-3" />
                Kill
              </Button>
            </Tooltip>
          </div>
        </div>
        <div className="mt-1 pl-[18px] font-mono text-[11.5px] text-ink-faint">pid {entry.pid}</div>
      </header>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-5">
        <div className="max-w-[680px] space-y-6">
          <section className="space-y-2">
            <h2 className="eyebrow text-ink-faint">Command</h2>
            <CopyBlock text={entry.command} label="command" wrap />
          </section>
          <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-2 text-[12.5px]">
            {facts.map((fact) => (
              <React.Fragment key={fact.label}>
                <dt className="text-ink-faint">{fact.label}</dt>
                <dd className="selectable min-w-0 font-mono text-[12px] break-words text-ink-muted">{fact.value}</dd>
              </React.Fragment>
            ))}
          </dl>
          <section className="space-y-2 border-t border-line pt-5">
            <h2 className="eyebrow text-ink-faint">Its output</h2>
            <p className="text-[12.5px] text-ink-muted">
              agenterm did not start this, so it cannot show what it prints or let you type into it.
              {rerun === null
                ? ' Its command line holds a secret, so start it again yourself with agenterm run.'
                : ' To watch it here, stop it and run it with agenterm:'}
            </p>
            {rerun === null ? null : <CopyBlock text={rerun} label="command" wrap />}
          </section>
        </div>
      </div>
    </div>
  );
}

/** Main pane when the outside list is showing but nothing is picked. */
export function OutsideEmpty({ count }: { count: number }): React.JSX.Element {
  return (
    <EmptyState
      className="h-full"
      title={count === 0 ? 'Nothing is running outside agenterm' : 'Pick a command on the left'}
      detail="Dev servers and watchers started in other terminals or by agents show up here, and so do ones left behind when their terminal or agent closed. Orphans are listed first."
    />
  );
}
