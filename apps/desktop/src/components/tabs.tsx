import type {
  AgentermEvent,
  CommandRecord,
  FileChangesResponse,
  GitFileState,
  GitStatusResponse,
  PortRecord,
  ProcessSnapshot,
  SessionRecord
} from '@agenterm/core';
import { Button, cn, EmptyState, Spinner } from '@agenterm/ui';
import type { UseQueryResult } from '@tanstack/react-query';
import { ExternalLink, FileDiff, FolderGit2, GitBranch, Radio, TerminalSquare } from 'lucide-react';
import * as React from 'react';
import { api, getBridge } from '../lib/bridge.js';
import { compactCommand, describeEvent, formatAge, formatBytes, formatClock, formatDuration } from '../lib/format.js';
import { useLive } from '../lib/live.js';
import { useDiff } from '../lib/queries.js';

function Loading(): React.JSX.Element {
  // Queries wait while the daemon is away; say so instead of spinning.
  const online = useLive((state) => state.connection.state === 'online');
  if (!online) return <EmptyState title="Waiting for the daemon" detail="This view loads once it is back." />;
  return (
    <div className="flex h-40 items-center justify-center">
      <Spinner />
    </div>
  );
}

function ErrorState({ error, retry }: { error: unknown; retry: () => void }): React.JSX.Element {
  return (
    <EmptyState
      title="Could not load this view"
      detail={error instanceof Error ? error.message : String(error)}
      action={
        <Button size="sm" onClick={retry}>
          Try again
        </Button>
      }
    />
  );
}

// --- commands --------------------------------------------------------------

export function CommandsTab({ query }: { query: UseQueryResult<CommandRecord[]> }): React.JSX.Element {
  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  const rows = query.data;
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<TerminalSquare className="size-6" />}
        title="No commands recorded yet"
        detail="Commands appear here when the terminal shows a shell prompt followed by a command."
      />
    );
  }
  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <table className="w-full border-collapse text-[12.5px]">
        <thead className="sticky top-0 bg-canvas text-left">
          <tr className="eyebrow text-ink-faint">
            <th className="w-24 px-4 py-2 font-semibold">When</th>
            <th className="w-24 px-2 py-2 font-semibold">Took</th>
            <th className="w-20 px-2 py-2 text-right font-semibold">Lines</th>
            <th className="px-4 py-2 font-semibold">Command</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-t border-line hover:bg-panel">
              <td
                className="px-4 py-1.5 font-mono text-[11.5px] text-ink-muted"
                title={new Date(row.startedAtMs).toLocaleString()}
              >
                {formatClock(row.startedAtMs)}
              </td>
              <td className="px-2 py-1.5 font-mono text-[11.5px] text-ink-muted">
                {row.durationMs === null ? <span className="text-work">running</span> : formatDuration(row.durationMs)}
              </td>
              <td className="px-2 py-1.5 text-right font-mono text-[11.5px] text-ink-muted">
                {row.outputLineCount ?? 0}
              </td>
              <td className="selectable truncate px-4 py-1.5 font-mono text-[12px] text-ink">{row.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-4 py-3 text-[11.5px] text-ink-faint">
        Rows are inferred from prompts in the output, so exit codes are not shown.
      </p>
    </div>
  );
}

// --- git -------------------------------------------------------------------

const STATE_LETTER: Record<string, { letter: string; className: string; label: string }> = {
  modified: { letter: 'M', className: 'text-work', label: 'modified' },
  added: { letter: 'A', className: 'text-ok', label: 'added' },
  deleted: { letter: 'D', className: 'text-fail', label: 'deleted' },
  renamed: { letter: 'R', className: 'text-accent', label: 'renamed' },
  copied: { letter: 'C', className: 'text-accent', label: 'copied' },
  untracked: { letter: 'U', className: 'text-attn', label: 'new, untracked' },
  conflicted: { letter: '!', className: 'text-fail', label: 'conflict' },
  typechange: { letter: 'T', className: 'text-ink-muted', label: 'type changed' }
};

function StateLetter({ state, staged }: { state: string | null; staged: boolean }): React.JSX.Element {
  if (state === null) return <span className="w-3" />;
  const info = STATE_LETTER[state] ?? { letter: '?', className: 'text-ink-muted', label: state };
  return (
    <span
      className={cn('w-3 text-center font-mono text-[11px] font-semibold', info.className)}
      title={`${info.label}${staged ? ' (staged)' : ''}`}
    >
      {info.letter}
    </span>
  );
}

export function GitTab({
  session,
  query,
  selected,
  onSelect
}: {
  session: SessionRecord;
  query: UseQueryResult<GitStatusResponse>;
  selected: string | null;
  onSelect: (path: string | null) => void;
}): React.JSX.Element {
  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  const status = query.data;
  if (status.worktreeRoot === null) {
    return (
      <EmptyState
        icon={<FolderGit2 className="size-6" />}
        title="Not a git repository"
        detail={`${session.cwd} is not inside a git working tree, so there are no changes to show.`}
      />
    );
  }
  const active = selected ?? status.files[0]?.path ?? null;
  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-[300px] shrink-0 flex-col border-r border-line">
        <div className="border-b border-line px-4 py-2.5">
          <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink">
            <GitBranch className="size-3.5" /> {status.branch ?? 'detached HEAD'}
          </div>
          <div className="mt-0.5 font-mono text-[11.5px] text-ink-muted">
            {status.isDirty ? (
              <>
                <span className="text-ok">+{status.insertions}</span>{' '}
                <span className="text-fail">−{status.deletions}</span> · {status.stagedCount} staged ·{' '}
                {status.unstagedCount} unstaged
              </>
            ) : (
              'Working tree clean'
            )}
          </div>
        </div>
        <ul className="scroll-thin flex-1 overflow-y-auto py-1" aria-label="Changed files">
          {status.files.map((file: GitFileState) => (
            <li key={file.path}>
              <button
                type="button"
                onClick={() => onSelect(file.path)}
                aria-current={active === file.path ? 'true' : undefined}
                className={cn(
                  'flex w-full items-center gap-1.5 px-4 py-1 text-left hover:bg-panel',
                  active === file.path && 'bg-accent-soft'
                )}
              >
                <StateLetter state={file.staged} staged />
                <StateLetter state={file.unstaged} staged={false} />
                <span className="ml-1 min-w-0 truncate font-mono text-[12px] text-ink" title={file.path}>
                  {file.path}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="min-w-0 flex-1">
        {active === null ? (
          <EmptyState
            icon={<FileDiff className="size-6" />}
            title="No changes"
            detail="Edits made in this workspace show up here as they happen."
          />
        ) : (
          <DiffView sessionId={session.id} path={active} />
        )}
      </div>
    </div>
  );
}

function DiffView({ sessionId, path }: { sessionId: string; path: string }): React.JSX.Element {
  const diff = useDiff(sessionId, path);
  if (diff.isPending) return <Loading />;
  if (diff.isError) return <ErrorState error={diff.error} retry={() => void diff.refetch()} />;
  const lines = diff.data.diff.length === 0 ? [] : diff.data.diff.replace(/\n$/, '').split('\n');
  return (
    <div className="scroll-thin h-full overflow-auto bg-term">
      <div className="sticky top-0 border-b border-line bg-panel px-4 py-1.5 font-mono text-[12px] text-ink">
        {path}
      </div>
      {lines.length === 0 ? (
        <p className="px-4 py-4 text-[12.5px] text-ink-muted">No textual changes versus HEAD.</p>
      ) : (
        <pre className="py-2 font-mono text-[12px] leading-[1.55]">
          {lines.map((line, i) => (
            <div
              key={i}
              className={cn(
                'px-4 whitespace-pre',
                line.startsWith('+') && !line.startsWith('+++') && 'bg-ok/12 text-ok',
                line.startsWith('-') && !line.startsWith('---') && 'bg-fail/12 text-fail',
                line.startsWith('@@') && 'bg-accent-soft text-accent',
                (line.startsWith('diff ') ||
                  line.startsWith('index ') ||
                  line.startsWith('+++') ||
                  line.startsWith('---')) &&
                  'text-ink-faint',
                !/^[-+@di]/.test(line) && 'text-ink'
              )}
            >
              {line.length === 0 ? ' ' : line}
            </div>
          ))}
        </pre>
      )}
      {diff.data.truncated ? <p className="px-4 pb-4 text-[12px] text-attn">Diff truncated at 256 KB.</p> : null}
    </div>
  );
}

// --- files -----------------------------------------------------------------

export function FilesTab({
  query,
  onOpen
}: {
  query: UseQueryResult<FileChangesResponse>;
  onOpen: (path: string) => void;
}): React.JSX.Element {
  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  const { changes, watching } = query.data;
  if (changes.length === 0) {
    return (
      <EmptyState
        icon={<FileDiff className="size-6" />}
        title={watching ? 'No file changes yet' : 'This folder is not watched'}
        detail={
          watching
            ? 'Files the agent creates, edits, or deletes appear here within a second.'
            : 'agenterm watches git working trees only, and never your whole home folder.'
        }
      />
    );
  }
  return (
    <ul className="scroll-thin h-full overflow-y-auto py-1">
      {changes.map((change) => (
        <li key={change.path}>
          <button
            type="button"
            onClick={() => onOpen(change.path)}
            className="flex w-full items-center gap-3 px-4 py-1.5 text-left hover:bg-panel"
          >
            <span
              className={cn(
                'w-16 text-[11.5px]',
                change.change === 'added' ? 'text-ok' : change.change === 'deleted' ? 'text-fail' : 'text-work'
              )}
            >
              {change.change === 'added' ? 'created' : change.change === 'deleted' ? 'deleted' : 'edited'}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">{change.path}</span>
            {change.count > 1 ? <span className="font-mono text-[11px] text-ink-faint">×{change.count}</span> : null}
            <span className="w-10 text-right font-mono text-[11px] text-ink-faint">{formatAge(change.atMs)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// --- processes -------------------------------------------------------------

/** Order the snapshot as a tree, leader first, children indented. */
function treeOrder(processes: ProcessSnapshot[], leader: number): Array<{ process: ProcessSnapshot; depth: number }> {
  const byParent = new Map<number, ProcessSnapshot[]>();
  for (const process of processes) {
    const list = byParent.get(process.ppid) ?? [];
    list.push(process);
    byParent.set(process.ppid, list);
  }
  const out: Array<{ process: ProcessSnapshot; depth: number }> = [];
  const visit = (pid: number, depth: number): void => {
    const self = processes.find((process) => process.pid === pid);
    if (self !== undefined) out.push({ process: self, depth });
    for (const child of byParent.get(pid) ?? []) visit(child.pid, depth + 1);
  };
  visit(leader, 0);
  for (const process of processes)
    if (!out.some((entry) => entry.process.pid === process.pid)) out.push({ process, depth: 0 });
  return out;
}

export function ProcessesTab({
  session,
  query
}: {
  session: SessionRecord;
  query: UseQueryResult<{ processes: ProcessSnapshot[]; ports: PortRecord[] }>;
}): React.JSX.Element {
  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  const { processes, ports } = query.data;
  const rows = treeOrder(processes, session.pid);
  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <section className="border-b border-line px-4 py-3">
        <h3 className="eyebrow mb-2 text-ink-faint">Listening ports</h3>
        {ports.length === 0 ? (
          <p className="text-[12.5px] text-ink-muted">Nothing in this session is listening on a port.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {ports.map((port) => (
              <button
                key={`${port.port}:${port.pid}`}
                type="button"
                onClick={() => void getBridge()?.openExternal(`http://localhost:${port.port}`)}
                className="flex items-center gap-2 rounded-md border border-line bg-panel px-3 py-1.5 hover:border-accent"
                title={`Open http://localhost:${port.port} in your browser`}
              >
                <Radio className="size-3.5 text-ok" />
                <span className="font-mono text-[13px] text-ink">:{port.port}</span>
                <span className="font-mono text-[11px] text-ink-faint">pid {port.pid}</span>
                <ExternalLink className="size-3 text-ink-faint" />
              </button>
            ))}
          </div>
        )}
      </section>
      {rows.length === 0 ? (
        <EmptyState title="No processes" detail="The session leader has exited, so there is no process tree to show." />
      ) : (
        <table className="w-full border-collapse text-[12.5px]">
          <thead className="text-left">
            <tr className="eyebrow text-ink-faint">
              <th className="w-20 px-4 py-2 font-semibold">PID</th>
              <th className="w-16 px-2 py-2 text-right font-semibold">CPU</th>
              <th className="w-20 px-2 py-2 text-right font-semibold">Memory</th>
              <th className="px-4 py-2 font-semibold">Command</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ process, depth }) => (
              <tr key={process.pid} className="border-t border-line">
                <td className="px-4 py-1.5 font-mono text-[11.5px] text-ink-muted">{process.pid}</td>
                <td className="px-2 py-1.5 text-right font-mono text-[11.5px] text-ink-muted">
                  {process.cpuPercent === null ? '—' : `${process.cpuPercent.toFixed(1)}%`}
                </td>
                <td className="px-2 py-1.5 text-right font-mono text-[11.5px] text-ink-muted">
                  {formatBytes(process.rssBytes)}
                </td>
                <td
                  className="selectable max-w-0 truncate px-4 py-1.5 font-mono text-[12px] text-ink"
                  title={process.command}
                >
                  <span className="text-ink-faint">{depth > 0 ? `${'  '.repeat(depth - 1)}└ ` : ''}</span>
                  {compactCommand(process.command) || '(exited)'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// --- activity --------------------------------------------------------------

const EVENT_TONE: Partial<Record<AgentermEvent['kind'], string>> = {
  'session.exited': 'bg-idle',
  'session.created': 'bg-work',
  'agent.status': 'bg-attn',
  'port.opened': 'bg-ok',
  'port.closed': 'bg-idle',
  'workspace.conflict': 'bg-idle',
  'file.changed': 'bg-line-strong'
};

const OVERLAY_TONE: Record<string, string> = {
  working: 'bg-work',
  waiting_input: 'bg-attn',
  waiting_permission: 'bg-attn',
  completed: 'bg-ok',
  failed: 'bg-fail'
};

function eventTone(event: AgentermEvent): string {
  if (event.kind === 'session.exited') {
    return event.exitSignal !== null || (event.exitCode !== null && event.exitCode !== 0) ? 'bg-fail' : 'bg-idle';
  }
  if (event.kind === 'agent.status') return OVERLAY_TONE[event.overlay] ?? 'bg-idle';
  return EVENT_TONE[event.kind] ?? 'bg-idle';
}

/** One line of the activity feed. */
export function EventRow({
  event,
  label,
  onOpen
}: {
  event: AgentermEvent;
  label?: string | undefined;
  onOpen?: (() => void) | undefined;
}): React.JSX.Element {
  return (
    <li className="group flex gap-2.5 py-1.5">
      <span className={cn('mt-[7px] size-1.5 shrink-0 rounded-full', eventTone(event))} />
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-[12.5px] leading-snug break-words text-ink" title={describeEvent(event)}>
          {describeEvent(event)}
        </p>
        <p className="mt-0.5 flex items-center gap-2 text-[11px] text-ink-faint">
          <span className="font-mono">{formatClock(event.createdAtMs)}</span>
          {label === undefined ? null : onOpen === undefined ? (
            <span className="callsign">{label}</span>
          ) : (
            <button type="button" onClick={onOpen} className="callsign hover:text-accent">
              {label}
            </button>
          )}
        </p>
      </div>
    </li>
  );
}

export function ActivityTab({ session }: { session: SessionRecord }): React.JSX.Element {
  const feed = useLive((state) => state.feed);
  const [history, setHistory] = React.useState<AgentermEvent[]>([]);
  React.useEffect(() => {
    let cancelled = false;
    void api('events', { sessionId: session.id, limit: 300 })
      .then((result) => {
        if (!cancelled) setHistory(result.events);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [session.id]);
  const seen = new Set<string>();
  const events = [...feed.filter((event) => event.sessionId === session.id), ...history]
    .filter((event) => (seen.has(event.id) ? false : (seen.add(event.id), true)))
    .sort((a, b) => b.createdAtMs - a.createdAtMs);
  if (events.length === 0) {
    return (
      <EmptyState
        title="No activity yet"
        detail="Starts, exits, status changes, ports, and file edits for this session show up here."
      />
    );
  }
  return (
    <ul className="scroll-thin h-full overflow-y-auto px-5 py-2">
      {events.map((event) => (
        <EventRow key={event.id} event={event} />
      ))}
    </ul>
  );
}
