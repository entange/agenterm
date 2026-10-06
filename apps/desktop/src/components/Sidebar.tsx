import type { SessionRecord } from '@agenterm/core';
import { Button, cn, IconButton, Kbd, signalBg, signalText } from '@agenterm/ui';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Bell,
  BellOff,
  ChevronRight,
  GitBranch,
  LayoutGrid,
  Monitor,
  Moon,
  Plus,
  Rows2,
  Rows3,
  Search,
  Sun
} from 'lucide-react';
import * as React from 'react';
import type { Attention } from '../../shared/attention.js';
import { callsign } from '../../shared/callsign.js';
import { buildRows, type BoardRow } from '../lib/board.js';
import { getBridge } from '../lib/bridge.js';
import { folderName, formatAge } from '../lib/format.js';
import { EMPTY_TRACE, useLive } from '../lib/live.js';
import { shortcut } from '../lib/shortcuts.js';
import { useUi, type ThemePreference } from '../lib/ui.js';
import { Trace } from './Trace.js';

/** Row heights in px; fixed so the virtualizer never measures. */
const HEIGHTS = { group: 30, more: 28, comfortable: 78, compact: 34 };

/**
 * The strip board. Sessions grouped by what they need (or by project),
 * sub-sessions nested under the session that started them, and only the
 * rows on screen mounted, so hundreds of terminals scroll smoothly.
 */
export function Sidebar({
  sessions,
  attention,
  onNewSession
}: {
  sessions: SessionRecord[];
  attention: Map<string, Attention>;
  onNewSession: () => void;
}): React.JSX.Element {
  const filter = useUi((state) => state.filter);
  const setFilter = useUi((state) => state.setFilter);
  const selectedId = useUi((state) => state.selectedId);
  const select = useUi((state) => state.select);
  const groupBy = useUi((state) => state.groupBy);
  const setGroupBy = useUi((state) => state.setGroupBy);
  const density = useUi((state) => state.density);
  const setDensity = useUi((state) => state.setDensity);
  const collapsedList = useUi((state) => state.collapsed);
  const toggleCollapsed = useUi((state) => state.toggleCollapsed);
  const [showAllEnded, setShowAllEnded] = React.useState(false);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const rows = React.useMemo(
    () => buildRows(sessions, attention, { groupBy, collapsed: new Set(collapsedList), filter, showAllEnded }),
    [sessions, attention, groupBy, collapsedList, filter, showAllEnded]
  );
  const heightOf = React.useCallback(
    (row: BoardRow | undefined): number =>
      row === undefined ? HEIGHTS.compact : row.kind === 'session' ? HEIGHTS[density] : HEIGHTS[row.kind],
    [density]
  );
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => heightOf(rows[index]),
    getItemKey: (index) => {
      const row = rows[index];
      return row === undefined ? index : row.kind === 'session' ? row.session.id : row.key;
    },
    overscan: 10
  });
  React.useEffect(() => virtualizer.measure(), [virtualizer, density]);

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

  /** Arrow keys walk the row model, so rows that are not mounted are reachable too. */
  const onListKey = (event: React.KeyboardEvent): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const sessionRows = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.kind === 'session');
    if (sessionRows.length === 0) return;
    event.preventDefault();
    const at = sessionRows.findIndex(({ row }) => row.kind === 'session' && row.session.id === selectedId);
    const next =
      sessionRows[
        at === -1 ? 0 : Math.min(sessionRows.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))
      ];
    if (next === undefined || next.row.kind !== 'session') return;
    select(next.row.session.id);
    virtualizer.scrollToIndex(next.index, { align: 'auto' });
  };

  const live = sessions.filter((session) => session.lifecycle === 'running').length;

  return (
    <aside className="flex h-full w-[300px] shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <label className="relative flex-1">
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
            placeholder="Filter sessions"
            aria-label="Filter sessions"
            className="h-7 w-full rounded-md border border-line bg-raised pr-7 pl-7 text-[12.5px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
          />
          <Kbd className="absolute top-1/2 right-1.5 -translate-y-1/2">/</Kbd>
        </label>
        <IconButton
          label="New session"
          shortcut={shortcut('N')}
          onClick={onNewSession}
          className="border border-line bg-raised"
        >
          <Plus className="size-4" />
        </IconButton>
      </div>

      <button
        type="button"
        onClick={() => select(null)}
        aria-current={selectedId === null ? 'page' : undefined}
        className={cn(
          'mx-2 flex h-8 items-center gap-2 rounded-md px-2 text-[12.5px] text-ink-muted hover:bg-sunken hover:text-ink',
          selectedId === null && 'bg-accent-soft text-ink'
        )}
      >
        <LayoutGrid className="size-3.5" />
        Control room
        <Kbd className="ml-auto">{shortcut('H', { shift: true })}</Kbd>
      </button>

      <div className="mt-2 flex items-center gap-1 px-3 pb-1.5">
        <span className="flex-1 text-[11px] text-ink-faint">
          {sessions.length} sessions · {live} running
        </span>
        <div
          role="radiogroup"
          aria-label="Group sessions by"
          className="flex rounded-md border border-line bg-sunken p-0.5 text-[11px]"
        >
          {(['status', 'project'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={groupBy === value}
              onClick={() => setGroupBy(value)}
              className={cn(
                'rounded px-1.5 py-0.5',
                groupBy === value ? 'bg-raised text-ink shadow-sm' : 'text-ink-muted hover:text-ink'
              )}
            >
              {value === 'status' ? 'Status' : 'Project'}
            </button>
          ))}
        </div>
        <IconButton
          label={density === 'compact' ? 'Show detailed rows' : 'Show compact rows'}
          onClick={() => setDensity(density === 'compact' ? 'comfortable' : 'compact')}
        >
          {density === 'compact' ? <Rows2 className="size-3.5" /> : <Rows3 className="size-3.5" />}
        </IconButton>
      </div>

      <div
        ref={scrollRef}
        role="listbox"
        aria-label="Sessions"
        tabIndex={0}
        onKeyDown={onListKey}
        className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3 outline-none"
      >
        {sessions.length === 0 ? (
          <div className="mt-6 px-3 text-center text-[12.5px] text-ink-muted">
            <p>No sessions yet.</p>
            <Button tone="secondary" size="sm" className="mt-3" onClick={onNewSession}>
              <Plus className="size-3.5" /> New session
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <p className="mt-6 px-3 text-center text-[12.5px] text-ink-muted">Nothing matches “{filter}”.</p>
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              if (row === undefined) return null;
              return (
                <div
                  key={item.key}
                  className="absolute top-0 left-0 w-full"
                  style={{ height: item.size, transform: `translateY(${item.start}px)` }}
                >
                  {row.kind === 'group' ? (
                    <GroupHeader row={row} onToggle={() => toggleCollapsed(row.key)} />
                  ) : row.kind === 'more' ? (
                    <button
                      type="button"
                      className="flex h-full items-center gap-1 px-2 text-[12px] text-ink-faint hover:text-ink"
                      onClick={() => setShowAllEnded(true)}
                    >
                      <ChevronRight className="size-3" /> Show {row.hidden} more
                    </button>
                  ) : (
                    <Strip
                      row={row}
                      attention={attention.get(row.session.id)}
                      selected={row.session.id === selectedId}
                      compact={density === 'compact'}
                      onSelect={() => select(row.session.id)}
                      onToggleChildren={() => toggleCollapsed(`parent:${row.session.id}`)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <SidebarFooter />
    </aside>
  );
}

function GroupHeader({
  row,
  onToggle
}: {
  row: Extract<BoardRow, { kind: 'group' }>;
  onToggle: () => void;
}): React.JSX.Element {
  const urgent = row.group === 'needs-you' || (row.group === null && row.needsYou > 0);
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!row.collapsed}
      title={row.title}
      className={cn(
        'eyebrow flex h-full w-full items-center gap-1.5 px-1.5 text-left',
        urgent && row.group !== null ? 'text-attn' : 'text-ink-faint'
      )}
    >
      <ChevronRight className={cn('size-3 shrink-0 transition-transform', !row.collapsed && 'rotate-90')} />
      <span
        className={cn(
          'truncate',
          row.group === null && 'normal-case tracking-normal text-[11.5px] font-medium text-ink-muted'
        )}
      >
        {row.label}
      </span>
      <span className="font-mono text-[10px] tracking-normal">{row.count}</span>
      {row.group === null ? (
        <span className="ml-auto flex items-center gap-1.5 font-mono text-[10px] tracking-normal">
          {row.needsYou > 0 ? <span className="text-attn">{row.needsYou} waiting</span> : null}
          {row.working > 0 ? <span className="text-work">{row.working} busy</span> : null}
        </span>
      ) : null}
    </button>
  );
}

const Strip = React.memo(function Strip({
  row,
  attention,
  selected,
  compact,
  onSelect,
  onToggleChildren
}: {
  row: Extract<BoardRow, { kind: 'session' }>;
  attention: Attention | undefined;
  selected: boolean;
  compact: boolean;
  onSelect: () => void;
  onToggleChildren: () => void;
}): React.JSX.Element {
  const { session, depth } = row;
  const samples = useLive((state) => state.traces[session.id]);
  const lastLine = useLive((state) => state.lastLine[session.id]);
  const signal = attention?.signal ?? 'idle';
  const live = attention?.group !== 'ended' && session.lifecycle === 'running';
  const needsYou = attention?.group === 'needs-you';
  const detail = needsYou || !live || lastLine === undefined ? attention?.reason : lastLine;
  return (
    <div className="h-full pb-1" style={{ paddingLeft: depth * 14 }}>
      <div
        role="option"
        aria-selected={selected}
        onClick={onSelect}
        className={cn(
          'group relative flex h-full w-full cursor-default overflow-hidden rounded-md border pr-2 pl-3.5 text-left transition-colors',
          compact ? 'items-center gap-2' : 'flex-col justify-center gap-0.5 py-1.5',
          selected
            ? 'border-line-strong bg-raised shadow-sm'
            : 'border-transparent hover:border-line hover:bg-raised/60',
          !live && !needsYou && 'opacity-65 hover:opacity-100'
        )}
      >
        <span
          aria-hidden
          className={cn(
            'absolute inset-y-0 left-0 w-[3px]',
            signalBg[signal],
            needsYou && signal === 'attn' && 'attn-breathe'
          )}
        />
        {compact ? (
          <>
            <span
              className={cn('callsign w-[70px] shrink-0 text-[10px]', needsYou ? signalText[signal] : 'text-ink-faint')}
            >
              {callsign(session)}
            </span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{session.title}</span>
            {row.children > 0 ? <ChildToggle row={row} onToggle={onToggleChildren} /> : null}
            {live && session.origin === 'spawned' ? (
              <Trace samples={samples ?? EMPTY_TRACE} signal={signal} className="w-12 shrink-0" height={12} />
            ) : (
              <span className="font-mono text-[10px] text-ink-faint">
                {formatAge(session.endedAtMs ?? session.startedAtMs)}
              </span>
            )}
          </>
        ) : (
          <>
            <span className="flex items-center gap-2">
              <span className={cn('callsign text-[10.5px]', needsYou ? signalText[signal] : 'text-ink-faint')}>
                {callsign(session)}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{session.title}</span>
              {row.children > 0 ? <ChildToggle row={row} onToggle={onToggleChildren} /> : null}
              <span className="font-mono text-[10.5px] text-ink-faint">
                {formatAge(session.endedAtMs ?? session.startedAtMs)}
              </span>
            </span>
            <span className={cn('truncate font-mono text-[11px]', needsYou ? signalText[signal] : 'text-ink-muted')}>
              {detail ?? ' '}
            </span>
            <span className="flex items-center gap-2">
              <span className="flex min-w-0 items-center gap-1 text-[11px] text-ink-faint">
                {session.branch === null ? null : (
                  <>
                    <GitBranch className="size-3 shrink-0" />
                    <span className="max-w-[88px] truncate">{session.branch}</span>
                    <span>·</span>
                  </>
                )}
                <span className="truncate">{folderName(session.cwd)}</span>
              </span>
              {live && session.origin === 'spawned' ? (
                <Trace
                  samples={samples ?? EMPTY_TRACE}
                  signal={signal}
                  className="ml-auto max-w-[96px] min-w-[64px] flex-1"
                  height={14}
                />
              ) : null}
            </span>
          </>
        )}
      </div>
    </div>
  );
});

function ChildToggle({
  row,
  onToggle
}: {
  row: Extract<BoardRow, { kind: 'session' }>;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      aria-expanded={!row.collapsed}
      title={row.collapsed ? `Show ${row.children} sub-sessions` : `Hide ${row.children} sub-sessions`}
      className="flex shrink-0 items-center gap-0.5 rounded border border-line px-1 font-mono text-[10px] text-ink-muted hover:text-ink"
    >
      <ChevronRight className={cn('size-2.5 transition-transform', !row.collapsed && 'rotate-90')} />
      {row.children}
    </button>
  );
}

const THEME_NEXT: Record<ThemePreference, ThemePreference> = { system: 'dark', dark: 'light', light: 'system' };

function SidebarFooter(): React.JSX.Element {
  const theme = useUi((state) => state.theme);
  const setTheme = useUi((state) => state.setTheme);
  const connection = useLive((state) => state.connection);
  const [notifications, setNotifications] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    void getBridge()
      ?.preferences()
      .then((prefs) => setNotifications(prefs.notifications));
  }, []);

  const ThemeIcon = theme === 'system' ? Monitor : theme === 'dark' ? Moon : Sun;
  const online = connection.state === 'online';
  return (
    <div className="flex items-center gap-1 border-t border-line px-3 py-2">
      <span
        className={cn(
          'size-1.5 rounded-full',
          online ? 'bg-ok' : connection.state === 'starting' ? 'bg-attn' : 'bg-fail'
        )}
      />
      <span className="flex-1 truncate text-[11.5px] text-ink-faint">
        {online
          ? `Daemon ${connection.version ?? ''}`
          : connection.state === 'starting'
            ? 'Starting daemon…'
            : 'Daemon offline'}
      </span>
      <IconButton
        label={notifications === false ? 'Turn notifications on' : 'Turn notifications off'}
        onClick={() => {
          const next = notifications === false;
          setNotifications(next);
          void getBridge()?.setPreferences({ notifications: next });
        }}
      >
        {notifications === false ? <BellOff className="size-3.5" /> : <Bell className="size-3.5" />}
      </IconButton>
      <IconButton label={`Theme: ${theme}`} onClick={() => setTheme(THEME_NEXT[theme])}>
        <ThemeIcon className="size-3.5" />
      </IconButton>
    </div>
  );
}
