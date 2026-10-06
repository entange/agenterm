import type { SessionRecord } from '@agenterm/core';
import { Button, cn, IconButton, Kbd, signalBg, signalText } from '@agenterm/ui';
import { Bell, BellOff, ChevronRight, GitBranch, LayoutGrid, Monitor, Moon, Plus, Search, Sun } from 'lucide-react';
import * as React from 'react';
import { ATTENTION_ORDER, type Attention, type AttentionGroup } from '../../shared/attention.js';
import { callsign } from '../../shared/callsign.js';
import { getBridge } from '../lib/bridge.js';
import { folderName, formatAge } from '../lib/format.js';
import { EMPTY_TRACE, useLive } from '../lib/live.js';
import { useUi, type ThemePreference } from '../lib/ui.js';
import { Trace } from './Trace.js';
import { shortcut } from '../lib/shortcuts.js';

const GROUP_LABELS: Record<AttentionGroup, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  quiet: 'Quiet',
  ended: 'Ended'
};

const ENDED_PREVIEW = 6;

function matches(session: SessionRecord, query: string): boolean {
  if (query.length === 0) return true;
  const haystack = [session.title, callsign(session), session.cwd, session.branch ?? '', session.provider]
    .join(' ')
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((term) => haystack.includes(term));
}

/** Sessions grouped by what they need from the user, in board order. */
export function boardOrder(
  sessions: SessionRecord[],
  attention: Map<string, Attention>
): Array<[AttentionGroup, SessionRecord[]]> {
  const groups = new Map<AttentionGroup, SessionRecord[]>(ATTENTION_ORDER.map((group) => [group, []]));
  for (const session of sessions) {
    groups.get(attention.get(session.id)?.group ?? 'quiet')?.push(session);
  }
  return ATTENTION_ORDER.map((group) => [group, groups.get(group) ?? []]);
}

/**
 * The strip board: every session as a flight strip, grouped by what it
 * needs from the user. The band carries the signal color; the trace is
 * the agent's output heartbeat over the last two minutes.
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
  const [showAllEnded, setShowAllEnded] = React.useState(false);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const visible = sessions.filter((session) => matches(session, filter.trim()));
  const groups = boardOrder(visible, attention);

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

  return (
    <aside className="flex h-full w-[296px] shrink-0 flex-col border-r border-line bg-panel">
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
            className="h-7 w-full rounded-md border border-line bg-raised pr-7 pl-7 text-[12.5px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
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
          'mx-2 mb-1 flex h-8 items-center gap-2 rounded-md px-2 text-[12.5px] text-ink-muted hover:bg-sunken hover:text-ink',
          selectedId === null && 'bg-accent-soft text-ink'
        )}
      >
        <LayoutGrid className="size-3.5" />
        Control room
        <Kbd className="ml-auto">{shortcut('H', { shift: true })}</Kbd>
      </button>

      <nav
        aria-label="Sessions"
        className="scroll-thin flex-1 overflow-y-auto px-2 pb-3"
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          const strips = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-strip]')];
          const index = strips.findIndex((strip) => strip === document.activeElement);
          if (index === -1) return;
          event.preventDefault();
          const next = strips[Math.min(strips.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))];
          next?.focus();
          next?.click();
        }}
      >
        {sessions.length === 0 ? (
          <div className="mt-6 px-3 text-center text-[12.5px] text-ink-muted">
            <p>No sessions yet.</p>
            <Button tone="secondary" size="sm" className="mt-3" onClick={onNewSession}>
              <Plus className="size-3.5" /> New session
            </Button>
          </div>
        ) : visible.length === 0 ? (
          <p className="mt-6 px-3 text-center text-[12.5px] text-ink-muted">Nothing matches “{filter}”.</p>
        ) : null}
        {groups.map(([group, members]) => {
          if (members.length === 0) return null;
          const shown = group === 'ended' && !showAllEnded ? members.slice(0, ENDED_PREVIEW) : members;
          return (
            <section key={group} className="mt-3 first:mt-1">
              <h2
                className={cn(
                  'eyebrow mb-1.5 flex items-center gap-2 px-2',
                  group === 'needs-you' ? 'text-attn' : 'text-ink-faint'
                )}
              >
                {GROUP_LABELS[group]}
                <span className="font-mono text-[10px] tracking-normal">{members.length}</span>
              </h2>
              <ul className="flex flex-col gap-1">
                {shown.map((session) => (
                  <li key={session.id}>
                    <Strip
                      session={session}
                      attention={attention.get(session.id)}
                      selected={session.id === selectedId}
                      onSelect={() => select(session.id)}
                    />
                  </li>
                ))}
              </ul>
              {group === 'ended' && members.length > ENDED_PREVIEW ? (
                <button
                  type="button"
                  className="mt-1 flex items-center gap-1 px-2 text-[12px] text-ink-faint hover:text-ink"
                  onClick={() => setShowAllEnded(!showAllEnded)}
                >
                  <ChevronRight className={cn('size-3 transition-transform', showAllEnded && 'rotate-90')} />
                  {showAllEnded ? 'Show fewer' : `Show ${members.length - ENDED_PREVIEW} more`}
                </button>
              ) : null}
            </section>
          );
        })}
      </nav>
      <SidebarFooter />
    </aside>
  );
}

function Strip({
  session,
  attention,
  selected,
  onSelect
}: {
  session: SessionRecord;
  attention: Attention | undefined;
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const samples = useLive((state) => state.traces[session.id]);
  const lastLine = useLive((state) => state.lastLine[session.id]);
  const signal = attention?.signal ?? 'idle';
  const live = attention?.group !== 'ended' && session.lifecycle === 'running';
  const needsYou = attention?.group === 'needs-you';
  const detail = needsYou || !live || lastLine === undefined ? attention?.reason : lastLine;
  return (
    <button
      type="button"
      data-strip
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'group relative flex w-full flex-col gap-0.5 overflow-hidden rounded-md border py-1.5 pr-2 pl-3.5 text-left transition-colors',
        selected ? 'border-accent/60 bg-raised shadow-sm' : 'border-transparent hover:border-line hover:bg-raised/60',
        !live && !needsYou && 'opacity-70 hover:opacity-100'
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
      <span className="flex items-center gap-2">
        <span className={cn('callsign text-[10.5px]', needsYou ? signalText[signal] : 'text-ink-faint')}>
          {callsign(session)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{session.title}</span>
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
