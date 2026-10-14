import { isRunning, statusText, type TaskRecord } from '@agenterm/core';
import { Button, cn, IconButton, SignalDot, Tooltip } from '@agenterm/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Copy, ExternalLink, Skull, Square, Trash2 } from 'lucide-react';
import * as React from 'react';
import { copyText, removeTask, stopTask } from '../lib/actions.js';
import { getBridge } from '../lib/bridge.js';
import { runtimeText, shortPath, signalOf } from '../lib/format.js';
import { taskLabel } from '../../shared/label.js';
import { CopyField } from './controls.js';
import { TerminalPane } from './TerminalPane.js';

function useSecondClock(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** One task: a thin header with what it is and what you can do, and its live terminal below. */
export function TaskView({ task }: { task: TaskRecord }): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <TaskHeader task={task} />
      <div className="min-h-0 flex-1">
        {/* A restart reuses the id with fresh output, so the terminal is keyed by the run too. */}
        <TerminalPane key={`${task.id}:${task.startedAtMs}`} task={task} />
      </div>
    </div>
  );
}

function TaskHeader({ task }: { task: TaskRecord }): React.JSX.Element {
  const client = useQueryClient();
  const running = isRunning(task);
  const now = useSecondClock(running);
  const [busy, setBusy] = React.useState<'stop' | 'kill' | null>(null);
  // A new task in the same view starts idle.
  React.useEffect(() => setBusy(null), [task.id, task.startedAtMs]);

  const stop = (force: boolean): void => {
    setBusy(force ? 'kill' : 'stop');
    void stopTask(client, task, force).finally(() => setBusy(null));
  };

  const facts: Array<{ key: string; node: React.ReactNode }> = [
    ...(taskLabel(task) === task.id ? [] : [{ key: 'id', node: <span className="text-ink-muted">id {task.id}</span> }]),
    {
      key: 'cwd',
      node: (
        <button
          type="button"
          className="hover:text-ink hover:underline"
          title={`Open ${task.cwd}`}
          onClick={() => void getBridge()?.revealPath(task.cwd)}
        >
          {shortPath(task.cwd)}
        </button>
      )
    },
    ...(task.branch === null ? [] : [{ key: 'branch', node: task.branch }]),
    ...(task.startedBy === null ? [] : [{ key: 'by', node: `by ${task.startedBy}` }]),
    ...(running ? [{ key: 'pid', node: `pid ${task.pid}` }] : []),
    { key: 'time', node: runtimeText(task, now) }
  ];

  return (
    <header className="shrink-0 border-b border-line bg-panel px-4 py-2.5">
      <div className="flex items-center gap-2.5">
        <SignalDot signal={signalOf(task)} />
        <h1 className="min-w-0 truncate text-[14px] font-semibold text-ink">{taskLabel(task)}</h1>
        <span
          className={cn(
            'shrink-0 text-[12px]',
            task.status === 'failed' ? 'text-fail' : running ? 'text-ok' : 'text-ink-faint'
          )}
        >
          {statusText(task)}
        </span>
        {task.ports.map((port) => (
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
          <IconButton label="Copy task id" onClick={() => copyText(task.id, 'task id')}>
            <Copy className="size-3.5" />
          </IconButton>
          {running ? (
            <>
              <Tooltip content="Ctrl+C, then end its processes if it keeps running">
                <Button size="sm" disabled={busy !== null} onClick={() => stop(false)}>
                  <Square className="size-3" />
                  {busy === 'stop' ? 'Stopping…' : 'Stop'}
                </Button>
              </Tooltip>
              <Tooltip content="End it and everything it started right now">
                <Button size="sm" tone="danger" disabled={busy === 'kill'} onClick={() => stop(true)}>
                  <Skull className="size-3" />
                  {busy === 'kill' ? 'Killing…' : 'Kill'}
                </Button>
              </Tooltip>
            </>
          ) : null}
          <IconButton label="Remove task" tone="danger" onClick={() => removeTask(client, task)}>
            <Trash2 className="size-3.5" />
          </IconButton>
        </div>
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-x-2 pl-[18px] font-mono text-[11.5px] text-ink-faint">
        <span className="selectable min-w-0 shrink truncate text-ink-muted" title={task.command}>
          $ {task.command}
        </span>
        {facts.map((fact) => (
          <span key={fact.key} className="flex shrink-0 items-center gap-2 whitespace-nowrap">
            <span aria-hidden className="text-line-strong">
              ·
            </span>
            {fact.node}
          </span>
        ))}
      </div>
    </header>
  );
}

/** Shown when there is nothing to look at yet: how tasks get here. */
export function Welcome({ hasTasks }: { hasTasks: boolean }): React.JSX.Element {
  return (
    <div className="scroll-thin flex h-full items-center justify-center overflow-y-auto p-8">
      <div className="w-full max-w-[520px]">
        <h1 className="text-[18px] font-semibold text-ink">
          {hasTasks ? 'Pick a task on the left' : 'Nothing running yet'}
        </h1>
        <p className="mt-1.5 text-[13px] text-ink-muted">
          Start dev servers, watchers, and builds from any terminal, or let your agent start them. Each one shows up
          here as a live terminal you can watch, type into, and stop.
        </p>
        <section className="mt-6 space-y-2">
          <h2 className="eyebrow text-ink-faint">From a terminal</h2>
          <CopyField text={'agenterm run "npm run dev"'} label="command" />
          <p className="text-[12px] text-ink-muted">
            Give it an id and it never starts twice:{' '}
            <code className="font-mono">agenterm run --id web "npm run dev"</code> returns the running one.
          </p>
        </section>
        <section className="mt-6 space-y-2">
          <h2 className="eyebrow text-ink-faint">For agents (MCP)</h2>
          <CopyField text="claude mcp add agenterm -- agenterm mcp" label="Claude Code setup" />
          <CopyField text="codex mcp add agenterm -- agenterm mcp" label="Codex setup" />
          <p className="text-[12px] text-ink-muted">
            Any other agent: add <code className="font-mono">agenterm mcp</code> as a stdio MCP server. Agents get the
            same run, list, logs, input, stop, and remove the CLI has.
          </p>
        </section>
      </div>
    </div>
  );
}
