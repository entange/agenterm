import type { AgentProvider, SessionRecord } from '@agenterm/core';
import { Button, cn, signalBg, signalText } from '@agenterm/ui';
import { ArrowRight, Eye, Plus, RotateCcw } from 'lucide-react';
import * as React from 'react';
import type { Attention } from '../../shared/attention.js';
import { callsign } from '../../shared/callsign.js';
import { useActions } from '../lib/actions.js';
import { folderName, formatAge, isLive, PROVIDER_NAMES, shortPath } from '../lib/format.js';
import { EMPTY_TRACE, useLive } from '../lib/live.js';
import { useDiscover } from '../lib/queries.js';
import { useUi } from '../lib/ui.js';
import { Trace } from './Trace.js';

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Control room: the answer to "what needs me, and what is everyone
 * doing?" before any single session is opened.
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
  const act = useActions();
  const live = sessions.filter(isLive);
  const needsYou = sessions.filter((session) => attention.get(session.id)?.group === 'needs-you');
  const ended = sessions.filter((session) => !isLive(session) && attention.get(session.id)?.group !== 'needs-you').slice(0, 5);
  const discover = useDiscover();
  const unmanaged = (discover.data ?? []).filter((candidate) => candidate.sessionId === null);
  const [showAllElsewhere, setShowAllElsewhere] = React.useState(false);
  const elsewhere = showAllElsewhere ? unmanaged : unmanaged.slice(0, 4);

  const headline =
    live.length === 0
      ? 'Nothing is running.'
      : `${plural(live.length, 'session is', 'sessions are')} running${needsYou.length > 0 ? `; ${plural(needsYou.length, 'needs', 'need')} you.` : '.'}`;

  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-[1080px] px-8 pt-7 pb-12">
        <div className="eyebrow text-ink-faint">Control room</div>
        <h1 className="mt-1 text-[22px] font-semibold tracking-tight text-ink">{headline}</h1>

        {needsYou.length > 0 ? (
          <section className="mt-6">
            <h2 className="eyebrow mb-2 text-attn">Needs you</h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
              {needsYou.map((session) => {
                const info = attention.get(session.id);
                const ended = !isLive(session);
                return (
                  <article key={session.id} className="relative overflow-hidden rounded-lg border border-line bg-panel p-3.5 pl-4.5">
                    <span aria-hidden className={cn('absolute inset-y-0 left-0 w-1', signalBg[info?.signal ?? 'attn'], !ended && 'attn-breathe')} />
                    <div className="flex items-center gap-2">
                      <span className={cn('callsign text-[11px]', signalText[info?.signal ?? 'attn'])}>{callsign(session)}</span>
                      <span className="truncate text-[13px] font-medium text-ink">{session.title}</span>
                    </div>
                    <p className={cn('mt-1 text-[12.5px]', signalText[info?.signal ?? 'attn'])}>{info?.reason}</p>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-ink-faint">{shortPath(session.cwd)}</p>
                    <div className="mt-3 flex gap-2">
                      <Button size="sm" tone="secondary" onClick={() => select(session.id)}>
                        Open <ArrowRight className="size-3.5" />
                      </Button>
                      {ended && session.origin === 'spawned' ? (
                        <Button size="sm" tone="quiet" onClick={() => void act.restart(session)}>
                          <RotateCcw className="size-3.5" /> Restart
                        </Button>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        ) : null}

        <section className="mt-8">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="eyebrow text-ink-faint">Board · last two minutes of output</h2>
            <Button size="sm" tone="quiet" onClick={() => onNewSession()}>
              <Plus className="size-3.5" /> New session
            </Button>
          </div>
          {live.length === 0 ? (
            <QuickStart onNewSession={onNewSession} />
          ) : (
            <div className="overflow-hidden rounded-lg border border-line bg-panel">
              {live.map((session, i) => (
                <BoardRow key={session.id} session={session} attention={attention.get(session.id)} first={i === 0} onOpen={() => select(session.id)} />
              ))}
            </div>
          )}
        </section>

        {unmanaged.length > 0 ? (
          <section className="mt-8">
            <h2 className="eyebrow mb-1 text-ink-faint">Running elsewhere</h2>
            <p className="mb-2 text-[12.5px] text-ink-muted">
              Agents started outside agenterm. Attach to watch their processes, ports, and changes without touching them.
            </p>
            <div className="overflow-hidden rounded-lg border border-line bg-panel">
              {elsewhere.map((candidate, i) => (
                <div key={candidate.pid} className={cn('flex items-center gap-3 px-4 py-2', i > 0 && 'border-t border-line')}>
                  <span className="w-28 text-[12.5px] text-ink">{PROVIDER_NAMES[candidate.provider]}</span>
                  <span className="w-44 truncate font-mono text-[11.5px] text-ink-muted">
                    {candidate.cwd === null ? 'folder unknown' : shortPath(candidate.cwd)}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint" title={candidate.commandLine}>
                    pid {candidate.pid} · {candidate.commandLine}
                  </span>
                  <Button size="sm" tone="secondary" onClick={() => useUi.getState().openDialog({ kind: 'attach', candidate })}>
                    <Eye className="size-3.5" /> Attach
                  </Button>
                </div>
              ))}
            </div>
            {unmanaged.length > 4 ? (
              <button type="button" onClick={() => setShowAllElsewhere(!showAllElsewhere)} className="mt-1.5 text-[12px] text-ink-faint hover:text-ink">
                {showAllElsewhere ? 'Show fewer' : `Show ${unmanaged.length - 4} more`}
              </button>
            ) : null}
          </section>
        ) : null}

        {ended.length > 0 ? (
          <section className="mt-8">
            <h2 className="eyebrow mb-2 text-ink-faint">Recently ended</h2>
            <ul className="overflow-hidden rounded-lg border border-line bg-panel">
              {ended.map((session, i) => (
                <li key={session.id} className={cn(i > 0 && 'border-t border-line')}>
                  <button type="button" onClick={() => select(session.id)} className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-raised">
                    <span className="callsign w-24 text-[11px] text-ink-faint">{callsign(session)}</span>
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">{session.title}</span>
                    <span className="text-[12px] text-ink-muted">{attention.get(session.id)?.reason}</span>
                    <span className="w-10 text-right font-mono text-[11px] text-ink-faint">{formatAge(session.endedAtMs ?? session.startedAtMs)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
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
  const signal = attention?.signal ?? 'idle';
  return (
    <button type="button" onClick={onOpen} className={cn('relative grid w-full grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_200px_44px] items-center gap-4 py-2.5 pr-4 pl-5 text-left hover:bg-raised', !first && 'border-t border-line')}>
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
      <span className={cn('truncate font-mono text-[11.5px]', attention?.group === 'needs-you' ? signalText[signal] : 'text-ink-muted')}>
        {attention?.group === 'needs-you' || lastLine === undefined ? attention?.reason : lastLine}
      </span>
      {session.origin === 'spawned' ? (
        <Trace samples={samples ?? EMPTY_TRACE} signal={signal} height={26} />
      ) : (
        <span className="text-[11.5px] text-ink-faint">Attached: output not visible</span>
      )}
      <span className="text-right font-mono text-[11px] text-ink-faint">{formatAge(session.startedAtMs)}</span>
    </button>
  );
}

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
          <Button key={entry.provider} tone={entry.provider === 'claude' ? 'primary' : 'secondary'} onClick={() => onNewSession(entry.provider)}>
            {PROVIDER_NAMES[entry.provider]}
            <span className="font-mono text-[11px] opacity-70">{entry.hint}</span>
          </Button>
        ))}
      </div>
    </div>
  );
}
