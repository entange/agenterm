import type { SessionRecord } from '@agenterm/core';
import { cn } from '@agenterm/ui';
import * as React from 'react';
import { callsign } from '../../shared/callsign.js';
import { useLive } from '../lib/live.js';
import { useUi } from '../lib/ui.js';
import { EventRow } from './tabs.js';

type Scope = 'all' | 'session';

/**
 * Live activity across every session: starts, exits, status changes,
 * ports, and file edits, newest first. File edits are folded so one busy
 * agent cannot bury everything else.
 */
export function ActivityRail({ sessions }: { sessions: SessionRecord[] }): React.JSX.Element {
  const feed = useLive((state) => state.feed);
  const selectedId = useUi((state) => state.selectedId);
  const select = useUi((state) => state.select);
  const [scope, setScope] = React.useState<Scope>('all');
  const [showFiles, setShowFiles] = React.useState(false);
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const effectiveScope: Scope = selectedId === null ? 'all' : scope;
  const events = feed
    .filter((event) => (effectiveScope === 'all' ? true : event.sessionId === selectedId))
    .filter((event) => showFiles || event.kind !== 'file.changed')
    .slice(0, 150);

  return (
    <aside aria-label="Activity" className="flex h-full w-[300px] shrink-0 flex-col border-l border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <h2 className="eyebrow flex-1 text-ink-faint">Activity</h2>
        <div className="flex rounded-md border border-line bg-sunken p-0.5 text-[11.5px]">
          {(['all', 'session'] as const).map((value) => (
            <button
              key={value}
              type="button"
              disabled={value === 'session' && selectedId === null}
              onClick={() => setScope(value)}
              className={cn(
                'rounded px-2 py-0.5 disabled:opacity-40',
                effectiveScope === value ? 'bg-raised text-ink shadow-sm' : 'text-ink-muted hover:text-ink'
              )}
            >
              {value === 'all' ? 'All' : 'This session'}
            </button>
          ))}
        </div>
      </div>
      <label className="flex items-center gap-2 border-b border-line px-4 py-1.5 text-[11.5px] text-ink-muted">
        <input
          type="checkbox"
          checked={showFiles}
          onChange={(event) => setShowFiles(event.target.checked)}
          className="accent-[var(--accent)]"
        />
        Include file edits
      </label>
      {events.length === 0 ? (
        <p className="px-4 py-6 text-[12.5px] text-ink-muted">
          Starts, exits, status changes, and ports appear here as they happen.
        </p>
      ) : (
        <ul className="scroll-thin flex-1 overflow-y-auto px-4 py-1">
          {events.map((event) => {
            const session = byId.get(event.sessionId);
            return (
              <EventRow
                key={event.id}
                event={event}
                label={
                  effectiveScope === 'all'
                    ? session === undefined
                      ? event.sessionId.slice(0, 8)
                      : callsign(session)
                    : undefined
                }
                onOpen={session === undefined ? undefined : () => select(session.id)}
              />
            );
          })}
        </ul>
      )}
    </aside>
  );
}
