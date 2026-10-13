import type { AgentProvider, SessionRecord } from '@agenterm/core';
import { Button, cn, signalBg, signalText, type Signal } from '@agenterm/ui';
import { ArrowRight, Eye, Plus, RotateCcw } from 'lucide-react';
import * as React from 'react';
import type { Attention, AttentionGroup } from '../../shared/attention.js';
import { callsign } from '../../shared/callsign.js';
import { useActions } from '../lib/actions.js';
import { GROUP_LABELS, projectKey } from '../lib/board.js';
import { folderName, formatAge, formatCost, isLive, PROVIDER_NAMES, shortPath } from '../lib/format.js';
import { EMPTY_TRACE, useLive } from '../lib/live.js';
import { useDiscover } from '../lib/queries.js';
import { useUi } from '../lib/ui.js';
import { Trace } from './Trace.js';

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

const GROUP_SIGNAL: Record<AttentionGroup, Signal> = {
  'needs-you': 'attn',
  working: 'work',
  quiet: 'idle',
  ended: 'idle'
};
const NEEDS_PREVIEW = 6;
const BUSIEST = 8;

/**
 * Control room: the whole fleet at a glance, from five sessions to five
 * hundred. Counts and proportions first, then who needs you, then every
 * live session as one tile per session grouped by project, then where the
 * output is coming from right now.
 */
export function Home({
  sessions,
  attention,
  onNewSession
}: {
  sessions: SessionRecord[];
  attention: Map<string, Attention>;
  onNewSession: (provider?: AgentProvider) => void;
}): React.JSX.Element {
  const select = useUi((state) => state.select);
  const live = React.useMemo(() => sessions.filter(isLive), [sessions]);
  const counts = React.useMemo(() => {
    const out: Record<AttentionGroup, number> = { 'needs-you': 0, working: 0, quiet: 0, ended: 0 };
    for (const session of sessions) out[attention.get(session.id)?.group ?? 'quiet'] += 1;
    return out;
  }, [sessions, attention]);
  const needsYou = React.useMemo(
    () => sessions.filter((session) => attention.get(session.id)?.group === 'needs-you'),
    [sessions, attention]
  );
  const usage = useLive((state) => state.usage);
  const spend = Object.values(usage).reduce((total, entry) => total + entry.costUsd, 0);

  const headline =
    live.length === 0
      ? 'Nothing is running.'
      : `${plural(live.length, 'session is', 'sessions are')} running${needsYou.length > 0 ? `; ${plural(needsYou.length, 'needs', 'need')} you.` : '.'}`;

  return (
    <div className="scroll-thin @container h-full overflow-y-auto">
      <div className="mx-auto max-w-[1120px] px-8 pt-7 pb-12">
        <div className="eyebrow text-ink-faint">Control room</div>
        <div className="mt-1 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <h1 className="text-[22px] font-semibold tracking-tight text-ink">{headline}</h1>
          <div className="flex shrink-0 items-center gap-4 pb-1 text-[12px] text-ink-muted">
            {spend > 0 ? (
              <span title="Model spend reported by agents since the daemon started">
                <span className="font-mono text-ink">{formatCost(spend)}</span> spent
              </span>
            ) : null}
            <Button size="sm" tone="secondary" onClick={() => onNewSession()}>
              <Plus className="size-3.5" /> New session
            </Button>
          </div>
        </div>

        {sessions.length === 0 ? (
          <div className="mt-8">
            <QuickStart onNewSession={onNewSession} />
          </div>
        ) : (
          <>
            <StatusBar counts={counts} total={sessions.length} />
            {needsYou.length > 0 ? <NeedsYou sessions={needsYou} attention={attention} /> : null}
            {live.length > 0 ? <Fleet sessions={live} attention={attention} onOpen={select} /> : null}
            {live.length > 0 ? <Busiest sessions={live} attention={attention} onOpen={select} /> : null}
            <Projects sessions={sessions} attention={attention} />
          </>
        )}
        <RunningElsewhere />
        <RecentlyEnded sessions={sessions} attention={attention} onOpen={select} />
      </div>
    </div>
  );
}

const StatusBar = React.memo(function StatusBar({
  counts,
  total
}: {
  counts: Record<AttentionGroup, number>;
  total: number;
}): React.JSX.Element {
  const groupBy = useUi((state) => state.groupBy);
  const setGroupBy = useUi((state) => state.setGroupBy);
  const order: AttentionGroup[] = ['needs-you', 'working', 'quiet', 'ended'];
  return (
    <section className="mt-5">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-sunken" aria-hidden>
        {order.map((group) =>
          counts[group] === 0 ? null : (
            <span
              key={group}
              className={cn(
                signalBg[GROUP_SIGNAL[group]],
                group === 'ended' && 'opacity-35',
                group === 'quiet' && 'opacity-70'
              )}
              style={{ width: `${(counts[group] / total) * 100}%` }}
            />
          )
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-[12.5px]">
        {order.map((group) => (
          <span key={group} className="flex items-center gap-1.5 text-ink-muted">
            <span
              className={cn('size-2 rounded-full', signalBg[GROUP_SIGNAL[group]], group === 'ended' && 'opacity-50')}
            />
            <span className={cn('font-mono text-ink', group === 'needs-you' && counts[group] > 0 && 'text-attn')}>
              {counts[group]}
            </span>
            {GROUP_LABELS[group].toLowerCase()}
          </span>
        ))}
        {groupBy !== 'status' ? (
          <button
            type="button"
            className="ml-auto text-[12px] text-ink-faint hover:text-ink"
            onClick={() => setGroupBy('status')}
          >
            Group the sidebar by status
          </button>
        ) : null}
      </div>
    </section>
  );
});

const NeedsYou = React.memo(function NeedsYou({
  sessions,
  attention
}: {
  sessions: SessionRecord[];
  attention: Map<string, Attention>;
}): React.JSX.Element {
  const select = useUi((state) => state.select);
  const act = useActions();
  const [all, setAll] = React.useState(false);
  const shown = all ? sessions : sessions.slice(0, NEEDS_PREVIEW);
  return (
    <section className="mt-7">
      <h2 className="eyebrow mb-2 text-attn">Needs you · {sessions.length}</h2>
      <div className="overflow-hidden rounded-lg border border-line bg-panel">
        {shown.map((session, i) => {
          const info = attention.get(session.id);
          const signal = info?.signal ?? 'attn';
          const ended = !isLive(session);
          return (
            <div
              key={session.id}
              className={cn(
                'relative grid grid-cols-[84px_minmax(0,1fr)_auto] items-center gap-3 py-2 pr-3 pl-4 @3xl:grid-cols-[92px_minmax(0,0.9fr)_minmax(0,1.3fr)_minmax(0,0.6fr)_auto]',
                i > 0 && 'border-t border-line'
              )}
            >
              <span
                aria-hidden
                className={cn('absolute inset-y-0 left-0 w-[3px]', signalBg[signal], !ended && 'attn-breathe')}
              />
              <span className={cn('callsign truncate text-[11px]', signalText[signal])}>{callsign(session)}</span>
              <span className="min-w-0 @3xl:contents">
                <span className="block truncate text-[13px] font-medium text-ink">{session.title}</span>
                <span className={cn('block truncate text-[12.5px]', signalText[signal])} title={info?.reason}>
                  {info?.reason}
                </span>
              </span>
              <span className="hidden truncate text-[12px] text-ink-faint @3xl:block" title={session.cwd}>
                {folderName(session.cwd)}
                {session.branch === null ? null : <span className="font-mono text-[11px]"> · {session.branch}</span>}
              </span>
              <span className="flex items-center gap-1">
                {ended && session.origin === 'spawned' ? (
                  <Button size="sm" tone="quiet" onClick={() => void act.restart(session)}>
                    <RotateCcw className="size-3.5" /> Restart
                  </Button>
                ) : null}
                <Button size="sm" tone="secondary" onClick={() => select(session.id)}>
                  Open <ArrowRight className="size-3.5" />
                </Button>
              </span>
            </div>
          );
        })}
      </div>
      {sessions.length > NEEDS_PREVIEW ? (
        <button type="button" onClick={() => setAll(!all)} className="mt-1.5 text-[12px] text-ink-faint hover:text-ink">
          {all ? 'Show fewer' : `Show all ${sessions.length}`}
        </button>
      ) : null}
    </section>
  );
});

/** One tile per live session, grouped by project. Scales to hundreds without scrolling far. */
const Fleet = React.memo(function Fleet({
  sessions,
  attention,
  onOpen
}: {
  sessions: SessionRecord[];
  attention: Map<string, Attention>;
  onOpen: (id: string) => void;
}): React.JSX.Element {
  const groups = React.useMemo(() => {
    const byProject = new Map<string, SessionRecord[]>();
    for (const session of sessions) {
      const key = projectKey(session);
      byProject.set(key, [...(byProject.get(key) ?? []), session]);
    }
    return [...byProject.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [sessions]);
  return (
    <section className="mt-8">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="eyebrow text-ink-faint">Fleet · every live session</h2>
        <span className="flex items-center gap-3 text-[11.5px] whitespace-nowrap text-ink-faint">
          <Legend signal="attn" label="needs you" />
          <Legend signal="work" label="working" />
          <Legend signal="idle" label="quiet" />
          <Legend signal="fail" label="failed" />
        </span>
      </div>
      <div className="rounded-lg border border-line bg-panel px-4 py-3">
        {groups.map(([dir, members]) => (
          <div key={dir} className="flex items-start gap-4 py-1.5">
            <div className="w-28 shrink-0 pt-px @3xl:w-40" title={dir}>
              <div className="truncate text-[12.5px] text-ink">{folderName(dir)}</div>
              <div className="font-mono text-[10.5px] text-ink-faint">{members.length}</div>
            </div>
            <div className="flex flex-1 flex-wrap gap-1">
              {members.map((session) => {
                const info = attention.get(session.id);
                const signal = info?.signal ?? 'idle';
                return (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => onOpen(session.id)}
                    title={`${callsign(session)} · ${session.title}\n${info?.reason ?? ''}`}
                    aria-label={`${session.title}: ${info?.reason ?? ''}`}
                    className={cn(
                      'size-4 rounded-[3px] transition-transform hover:scale-125 focus-visible:scale-125',
                      signalBg[signal],
                      info?.group === 'quiet' && 'opacity-40',
                      info?.group === 'needs-you' && signal === 'attn' && 'attn-breathe'
                    )}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
});

function Legend({ signal, label }: { signal: Signal; label: string }): React.JSX.Element {
  return (
    <span className="flex items-center gap-1">
      <span className={cn('size-2 rounded-[2px]', signalBg[signal], signal === 'idle' && 'opacity-40')} />
      {label}
    </span>
  );
}

/** Top sessions by output over the last 30 seconds. Re-renders only when the ranking changes. */
function Busiest({
  sessions,
  attention,
  onOpen
}: {
  sessions: SessionRecord[];
  attention: Map<string, Attention>;
  onOpen: (id: string) => void;
}): React.JSX.Element | null {
  const liveIds = React.useMemo(() => new Set(sessions.map((session) => session.id)), [sessions]);
  const ranking = useLive((state) => {
    const scored: Array<[string, number]> = [];
    for (const [id, samples] of Object.entries(state.traces)) {
      if (!liveIds.has(id)) continue;
      let recent = 0;
      for (let i = samples.length - 30; i < samples.length; i++) recent += samples[i] ?? 0;
      if (recent > 0) scored.push([id, recent]);
    }
    return scored
      .sort((a, b) => b[1] - a[1])
      .slice(0, BUSIEST)
      .map(([id]) => id)
      .join(',');
  });
  const byId = React.useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);
  const top =
    ranking.length === 0
      ? []
      : ranking.split(',').flatMap((id) => (byId.has(id) ? [byId.get(id) as SessionRecord] : []));
  return (
    <section className="mt-8">
      <h2 className="eyebrow mb-2 text-ink-faint">Busiest right now · output in the last 30 seconds</h2>
      {top.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-4 py-3 text-[12.5px] text-ink-muted">
          No session has printed anything in the last 30 seconds.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-line bg-panel">
          {top.map((session, i) => (
            <BoardRow
              key={session.id}
              session={session}
              attention={attention.get(session.id)}
              first={i === 0}
              onOpen={() => onOpen(session.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function BoardRow({
  session,
  attention,
  first,
  onOpen
}: {
  session: SessionRecord;
  attention: Attention | undefined;
  first: boolean;
  onOpen: () => void;
}): React.JSX.Element {
  const samples = useLive((state) => state.traces[session.id]);
  const lastLine = useLive((state) => state.lastLine[session.id]);
  const spend = useLive((state) => state.usage[session.id]);
  const signal = attention?.signal ?? 'idle';
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'relative grid w-full grid-cols-[minmax(0,1fr)_96px_44px] items-center gap-3 py-2.5 pr-4 pl-5 text-left hover:bg-raised @3xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_200px_52px] @3xl:gap-4',
        !first && 'border-t border-line'
      )}
    >
      <span aria-hidden className={cn('absolute inset-y-0 left-0 w-[3px]', signalBg[signal])} />
      <span className="min-w-0">
        <span className="flex items-center gap-2">
          <span className={cn('callsign text-[10.5px]', signalText[signal])}>{callsign(session)}</span>
          <span className="truncate text-[13px] font-medium text-ink">{session.title}</span>
        </span>
        <span className="mt-0.5 block truncate text-[11.5px] text-ink-faint">
          {PROVIDER_NAMES[session.provider]} · {session.branch === null ? '' : `${session.branch} · `}
          {folderName(session.cwd)}
        </span>
      </span>
      <span
        className={cn(
          'hidden truncate font-mono text-[11.5px] @3xl:block',
          attention?.group === 'needs-you' ? signalText[signal] : 'text-ink-muted'
        )}
      >
        {attention?.group === 'needs-you' || lastLine === undefined ? attention?.reason : lastLine}
      </span>
      <Trace samples={samples ?? EMPTY_TRACE} signal={signal} height={26} />
      <span className="text-right font-mono text-[11px] leading-tight text-ink-faint">
        {formatAge(session.startedAtMs)}
        {spend === undefined ? null : <span className="block text-ink-muted">{formatCost(spend.costUsd)}</span>}
      </span>
    </button>
  );
}

/** Per-project summary: where sessions are, which folders need attention. */
const Projects = React.memo(function Projects({
  sessions,
  attention
}: {
  sessions: SessionRecord[];
  attention: Map<string, Attention>;
}): React.JSX.Element | null {
  const setFilter = useUi((state) => state.setFilter);
  const setGroupBy = useUi((state) => state.setGroupBy);
  const rows = React.useMemo(() => {
    const byProject = new Map<string, SessionRecord[]>();
    for (const session of sessions) {
      const key = projectKey(session);
      byProject.set(key, [...(byProject.get(key) ?? []), session]);
    }
    return [...byProject.entries()]
      .map(([dir, members]) => {
        const count = (group: AttentionGroup) =>
          members.filter((session) => attention.get(session.id)?.group === group).length;
        const branches = [
          ...new Set(members.map((session) => session.branch).filter((branch): branch is string => branch !== null))
        ];
        return {
          dir,
          total: members.length,
          live: members.filter(isLive).length,
          needs: count('needs-you'),
          working: count('working'),
          branches,
          lastStart: Math.max(...members.map((session) => session.startedAtMs))
        };
      })
      .sort((a, b) => b.needs - a.needs || b.live - a.live || b.lastStart - a.lastStart);
  }, [sessions, attention]);
  if (rows.length < 2) return null;
  return (
    <section className="mt-8">
      <h2 className="eyebrow mb-2 text-ink-faint">Projects</h2>
      <div className="overflow-hidden rounded-lg border border-line bg-panel">
        <div className="eyebrow grid grid-cols-[minmax(0,1fr)_64px_64px_64px] @3xl:grid-cols-[minmax(0,1.4fr)_70px_70px_70px_minmax(0,1fr)_60px] gap-3 border-b border-line px-4 py-2 text-ink-faint">
          <span>Folder</span>
          <span className="text-right">Running</span>
          <span className="text-right">Waiting</span>
          <span className="text-right">Busy</span>
          <span className="hidden @3xl:block">Branches</span>
          <span className="hidden text-right @3xl:block">Latest</span>
        </div>
        {rows.slice(0, 30).map((row) => (
          <button
            key={row.dir}
            type="button"
            title={`Show ${row.dir} in the sidebar`}
            onClick={() => {
              setGroupBy('project');
              setFilter(folderName(row.dir));
            }}
            className="grid w-full grid-cols-[minmax(0,1fr)_64px_64px_64px] @3xl:grid-cols-[minmax(0,1.4fr)_70px_70px_70px_minmax(0,1fr)_60px] items-center gap-3 border-t border-line px-4 py-2 text-left first-of-type:border-t-0 hover:bg-raised"
          >
            <span className="min-w-0">
              <span className="block truncate text-[12.5px] text-ink">{folderName(row.dir)}</span>
              <span className="block truncate font-mono text-[10.5px] text-ink-faint">{shortPath(row.dir)}</span>
            </span>
            <span className="text-right font-mono text-[12px] text-ink">
              {row.live}
              <span className="text-ink-faint">/{row.total}</span>
            </span>
            <span className={cn('text-right font-mono text-[12px]', row.needs > 0 ? 'text-attn' : 'text-ink-faint')}>
              {row.needs}
            </span>
            <span className={cn('text-right font-mono text-[12px]', row.working > 0 ? 'text-work' : 'text-ink-faint')}>
              {row.working}
            </span>
            <span className="hidden truncate font-mono text-[11px] text-ink-muted @3xl:block">
              {row.branches.join(', ') || '—'}
            </span>
            <span className="hidden text-right font-mono text-[11px] text-ink-faint @3xl:block">
              {formatAge(row.lastStart)}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
});

function RunningElsewhere(): React.JSX.Element | null {
  const discover = useDiscover();
  const unmanaged = (discover.data ?? []).filter((candidate) => candidate.sessionId === null);
  const [showAll, setShowAll] = React.useState(false);
  if (unmanaged.length === 0) return null;
  const shown = showAll ? unmanaged : unmanaged.slice(0, 4);
  return (
    <section className="mt-8">
      <h2 className="eyebrow mb-1 text-ink-faint">Running elsewhere</h2>
      <p className="mb-2 text-[12.5px] text-ink-muted">
        Agents started outside agenterm. Attach to watch their processes, ports, and changes without touching them.
      </p>
      <div className="overflow-hidden rounded-lg border border-line bg-panel">
        {shown.map((candidate, i) => (
          <div key={candidate.pid} className={cn('flex items-center gap-3 px-4 py-2', i > 0 && 'border-t border-line')}>
            <span className="w-28 text-[12.5px] text-ink">{PROVIDER_NAMES[candidate.provider]}</span>
            <span className="w-44 truncate font-mono text-[11.5px] text-ink-muted">
              {candidate.cwd === null ? 'folder unknown' : shortPath(candidate.cwd)}
            </span>
            <span
              className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint"
              title={candidate.commandLine}
            >
              pid {candidate.pid} · {candidate.commandLine}
            </span>
            <Button
              size="sm"
              tone="secondary"
              onClick={() => useUi.getState().openDialog({ kind: 'attach', candidate })}
            >
              <Eye className="size-3.5" /> Attach
            </Button>
          </div>
        ))}
      </div>
      {unmanaged.length > 4 ? (
        <button
          type="button"
          onClick={() => setShowAll(!showAll)}
          className="mt-1.5 text-[12px] text-ink-faint hover:text-ink"
        >
          {showAll ? 'Show fewer' : `Show ${unmanaged.length - 4} more`}
        </button>
      ) : null}
    </section>
  );
}

const RecentlyEnded = React.memo(function RecentlyEnded({
  sessions,
  attention,
  onOpen
}: {
  sessions: SessionRecord[];
  attention: Map<string, Attention>;
  onOpen: (id: string) => void;
}): React.JSX.Element | null {
  const ended = sessions
    .filter((session) => !isLive(session) && attention.get(session.id)?.group !== 'needs-you')
    .sort((a, b) => (b.endedAtMs ?? 0) - (a.endedAtMs ?? 0))
    .slice(0, 5);
  if (ended.length === 0) return null;
  return (
    <section className="mt-8">
      <h2 className="eyebrow mb-2 text-ink-faint">Recently ended</h2>
      <ul className="overflow-hidden rounded-lg border border-line bg-panel">
        {ended.map((session, i) => (
          <li key={session.id} className={cn(i > 0 && 'border-t border-line')}>
            <button
              type="button"
              onClick={() => onOpen(session.id)}
              className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-raised"
            >
              <span className="callsign w-24 text-[11px] text-ink-faint">{callsign(session)}</span>
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">{session.title}</span>
              <span className="text-[12px] text-ink-muted">{attention.get(session.id)?.reason}</span>
              <span className="w-10 text-right font-mono text-[11px] text-ink-faint">
                {formatAge(session.endedAtMs ?? session.startedAtMs)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
});

const QUICK: Array<{ provider: AgentProvider; hint: string }> = [
  { provider: 'claude', hint: 'claude' },
  { provider: 'codex', hint: 'codex' },
  { provider: 'gemini', hint: 'gemini' },
  { provider: 'opencode', hint: 'opencode' },
  { provider: 'generic', hint: 'any command' }
];

function QuickStart({ onNewSession }: { onNewSession: (provider?: AgentProvider) => void }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-dashed border-line-strong p-6">
      <p className="text-[13px] text-ink">Start an agent in a folder. It keeps running when you close this window.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {QUICK.map((entry) => (
          <Button
            key={entry.provider}
            tone={entry.provider === 'claude' ? 'primary' : 'secondary'}
            onClick={() => onNewSession(entry.provider)}
          >
            {PROVIDER_NAMES[entry.provider]}
            <span className="font-mono text-[11px] opacity-70">{entry.hint}</span>
          </Button>
        ))}
      </div>
    </div>
  );
}
