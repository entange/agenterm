import { isRunning, statusText, type TaskRecord } from '@agenterm/core';
import { Button, cn, SignalDot } from '@agenterm/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronRight, Search } from 'lucide-react';
import * as React from 'react';
import { taskLabel } from '../../shared/label.js';
import { clearEnded } from '../lib/actions.js';
import { formatAge, signalOf } from '../lib/format.js';
import { useLive } from '../lib/live.js';
import type { GroupBy, ListRow } from '../lib/tasks.js';
import { useUi } from '../lib/ui.js';
import { Segmented } from './controls.js';

/** Row heights in px; fixed so the virtualizer never measures. */
const HEIGHTS = { group: 28, task: 50 };

const GROUPINGS: Array<{ value: GroupBy; label: string }> = [
  { value: 'project', label: 'Project' },
  { value: 'agent', label: 'Started by' },
  { value: 'none', label: 'All' }
];

/** Re-render once a minute so ages stay current without ticking every row each second. */
function useMinuteClock(): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * Every task, grouped by project or by who started it. One click opens
 * the terminal with the cursor in it. Only the rows on screen are
 * mounted, so hundreds of tasks scroll smoothly.
 */
export function Sidebar({ rows, tasks }: { rows: ListRow[]; tasks: TaskRecord[] }): React.JSX.Element {
  const client = useQueryClient();
  const filter = useUi((state) => state.filter);
  const setFilter = useUi((state) => state.setFilter);
  const selectedId = useUi((state) => state.selectedId);
  const select = useUi((state) => state.select);
  const groupBy = useUi((state) => state.groupBy);
  const setGroupBy = useUi((state) => state.setGroupBy);
  const toggleCollapsed = useUi((state) => state.toggleCollapsed);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const now = useMinuteClock();

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index]?.kind === 'group' ? HEIGHTS.group : HEIGHTS.task),
    getItemKey: (index) => {
      const row = rows[index];
      return row === undefined ? index : row.kind === 'task' ? row.task.id : row.key;
    },
    overscan: 10
  });

  // Whatever selected a task (shortcut, palette, notification), bring its row into view.
  const rowsRef = React.useRef(rows);
  rowsRef.current = rows;
  React.useEffect(() => {
    if (selectedId === null) return;
    const index = rowsRef.current.findIndex((row) => row.kind === 'task' && row.task.id === selectedId);
    if (index !== -1) virtualizer.scrollToIndex(index, { align: 'auto' });
  }, [selectedId, virtualizer]);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const typing =
        target !== null &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.closest('.xterm') !== null);
      if (event.key === '/' && !typing) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** Arrow keys walk the list, Enter puts the cursor in the terminal. */
  const onListKey = (event: React.KeyboardEvent): void => {
    if (event.key === 'Enter' && selectedId !== null) {
      event.preventDefault();
      select(selectedId, { focus: true });
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const taskRows = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.kind === 'task');
    if (taskRows.length === 0) return;
    event.preventDefault();
    const at = taskRows.findIndex(({ row }) => row.kind === 'task' && row.task.id === selectedId);
    const next =
      taskRows[at === -1 ? 0 : Math.min(taskRows.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))];
    if (next === undefined || next.row.kind !== 'task') return;
    select(next.row.task.id);
    virtualizer.scrollToIndex(next.index, { align: 'auto' });
  };

  const running = tasks.filter(isRunning).length;
  const ended = tasks.length - running;

  return (
    <aside className="flex h-full w-[290px] shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex flex-col gap-2 px-3 pt-3 pb-2">
        <label className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-ink-faint" />
          <input
            ref={searchRef}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setFilter('');
                event.currentTarget.blur();
              }
            }}
            placeholder="Filter tasks"
            aria-label="Filter tasks"
            className="h-7 w-full rounded-md border border-line bg-raised pr-2 pl-7 text-[12.5px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
          />
        </label>
        <div className="flex items-center justify-between">
          <span className="eyebrow text-ink-faint">Group</span>
          <Segmented size="sm" label="Group tasks by" value={groupBy} options={GROUPINGS} onChange={setGroupBy} />
        </div>
      </div>
      <div
        ref={scrollRef}
        role="listbox"
        aria-label="Tasks"
        tabIndex={0}
        onKeyDown={onListKey}
        className="scroll-thin min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 focus:outline-none"
      >
        {rows.length === 0 ? (
          <p className="px-3 py-6 text-center text-[12px] text-ink-faint">
            {tasks.length === 0 ? 'No tasks yet.' : 'No task matches the filter.'}
          </p>
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              if (row === undefined) return null;
              return (
                <div key={item.key} className="absolute inset-x-0" style={{ top: item.start, height: item.size }}>
                  {row.kind === 'group' ? (
                    <GroupRow row={row} onToggle={() => toggleCollapsed(row.key)} />
                  ) : (
                    <TaskRow
                      task={row.task}
                      selected={row.task.id === selectedId}
                      now={now}
                      onSelect={() => select(row.task.id, { focus: true })}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="flex h-9 shrink-0 items-center justify-between border-t border-line px-3 text-[11.5px] text-ink-faint">
        <span>
          {running} running · {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}
        </span>
        {ended > 0 ? (
          <Button size="sm" tone="quiet" className="h-6 px-2 text-[11.5px]" onClick={() => void clearEnded(client)}>
            Clear ended
          </Button>
        ) : null}
      </div>
    </aside>
  );
}

function GroupRow({
  row,
  onToggle
}: {
  row: Extract<ListRow, { kind: 'group' }>;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      tabIndex={-1}
      onClick={onToggle}
      aria-expanded={!row.collapsed}
      className="flex h-full w-full items-center gap-1.5 rounded-md px-1.5 text-left text-ink-muted hover:text-ink"
    >
      <ChevronRight
        className={cn('size-3 shrink-0 text-ink-faint transition-transform', !row.collapsed && 'rotate-90')}
      />
      <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold">{row.label}</span>
      <span className="font-mono text-[10.5px] text-ink-faint">
        {row.running > 0 ? `${row.running}/${row.total}` : row.total}
      </span>
    </button>
  );
}

const TaskRow = React.memo(function TaskRow({
  task,
  selected,
  now,
  onSelect
}: {
  task: TaskRecord;
  selected: boolean;
  now: number;
  onSelect: () => void;
}): React.JSX.Element {
  const lastLine = useLive((state) => state.lastLine[task.id]);
  const running = isRunning(task);
  const detail = running ? (lastLine ?? task.command) : statusText(task);
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      onClick={onSelect}
      title={`${task.id} — ${task.command}`}
      className={cn(
        'flex h-[46px] w-full flex-col justify-center gap-0.5 rounded-md px-2 text-left transition-colors',
        selected ? 'bg-accent-soft' : 'hover:bg-sunken/70'
      )}
    >
      <span className="flex w-full items-center gap-2">
        <SignalDot signal={signalOf(task)} />
        <span className={cn('min-w-0 flex-1 truncate text-[13px]', running ? 'text-ink' : 'text-ink-muted')}>
          {taskLabel(task)}
        </span>
        {task.ports.length > 0 ? (
          <span className="shrink-0 font-mono text-[10.5px] text-ink-muted">:{task.ports[0]}</span>
        ) : null}
        <span className="shrink-0 text-[10.5px] text-ink-faint">{formatAge(task.startedAtMs, now)}</span>
      </span>
      <span
        className={cn(
          'block truncate pl-4 font-mono text-[11px]',
          task.status === 'failed' ? 'text-fail' : 'text-ink-faint'
        )}
      >
        {detail}
      </span>
    </button>
  );
});
