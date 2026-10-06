import type { AgentermEvent, SessionRecord } from '@agenterm/core';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import type { ActivityTick, AppCommand } from '../../shared/bridge.js';
import { api, getBridge } from './bridge.js';
import { useLive } from './live.js';
import { keys } from './queries.js';

/** Full session-list refetches happen at most this often; events patch rows in between. */
const LIST_REFRESH_MS = 1500;

/** Apply an event to the cached session list in place. Returns false when a refetch is needed. */
export function patchSessions(client: QueryClient, event: AgentermEvent): boolean {
  const current = client.getQueryData<SessionRecord[]>(keys.sessions);
  if (current === undefined) return false;
  const index = current.findIndex((session) => session.id === event.sessionId);
  if (index === -1) return event.kind !== 'session.created' && event.kind !== 'session.attached';
  const session = current[index] as SessionRecord;
  let next: SessionRecord | null = null;
  switch (event.kind) {
    case 'agent.status':
      next = { ...session, overlay: event.overlay, overlaySource: event.source };
      break;
    case 'session.updated':
      next = { ...session, title: event.title };
      break;
    case 'session.exited':
      next = {
        ...session,
        lifecycle: session.lifecycle === 'killed' ? 'killed' : 'exited',
        endedAtMs: session.endedAtMs ?? event.createdAtMs,
        exitCode: event.exitCode,
        exitSignal: event.exitSignal
      };
      break;
    case 'session.detached':
      client.setQueryData<SessionRecord[]>(
        keys.sessions,
        current.filter((entry) => entry.id !== event.sessionId)
      );
      return true;
    default:
      return true;
  }
  const copy = current.slice();
  copy[index] = next;
  client.setQueryData<SessionRecord[]>(keys.sessions, copy);
  return true;
}

/**
 * Connect the renderer to main once: connection state, a one-second
 * heartbeat clock fed by daemon activity frames, the activity feed, and
 * in-place cache patches so hundreds of sessions never trigger a refetch
 * per event.
 */
export function useDaemonWiring(onCommand: (command: AppCommand) => void): void {
  const client = useQueryClient();
  // Commands arrive through a ref so a new handler never re-subscribes the bridge.
  const commandRef = useRef(onCommand);
  commandRef.current = onCommand;

  useEffect(() => {
    const bridge = getBridge();
    if (bridge === null) return undefined;
    const live = useLive.getState();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const later = (key: string, ms: number, run: () => void): void => {
      if (timers.has(key)) return;
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          run();
        }, ms)
      );
    };
    const invalidate = (queryKey: readonly unknown[]): void => {
      void client.invalidateQueries({ queryKey });
    };
    const refreshList = (): void => later('sessions', LIST_REFRESH_MS, () => invalidate(keys.sessions));

    const seed = async (): Promise<void> => {
      const [events, activity, usage] = await Promise.allSettled([
        api('events', { limit: 200 }),
        api('activity'),
        api('usage')
      ]);
      if (events.status === 'fulfilled') live.seedFeed(events.value.events);
      if (activity.status === 'fulfilled') live.seedActivity(activity.value);
      if (usage.status === 'fulfilled') live.seedUsage(usage.value);
    };

    const onEvent = (event: AgentermEvent): void => {
      live.pushEvent(event);
      const id = event.sessionId;
      switch (event.kind) {
        case 'session.created':
        case 'session.attached':
        case 'workspace.conflict':
          refreshList();
          break;
        case 'session.exited':
        case 'session.updated':
        case 'agent.status':
        case 'session.detached':
          if (!patchSessions(client, event)) refreshList();
          if (event.kind === 'session.detached') live.forget(id);
          break;
        case 'port.opened':
        case 'port.closed':
          later(`processes:${id}`, 300, () => invalidate(keys.processes(id)));
          break;
        case 'file.changed':
          later(`files:${id}`, 400, () => invalidate(keys.files(id)));
          later(`git:${id}`, 1200, () => {
            invalidate(keys.git(id));
            invalidate(['diff', id]);
          });
          break;
        default:
          break;
      }
    };

    // Daemon frames arrive about once a second; a local clock folds them in so
    // traces keep moving (and flatten) even when nothing prints.
    let pending: ActivityTick['sessions'] = {};
    const clock = setInterval(() => {
      const incoming = pending;
      pending = {};
      useLive.getState().step(incoming, Date.now());
    }, 1000);

    const offEvent = bridge.onEvent(onEvent);
    const offActivity = bridge.onActivity((tick) => {
      for (const [id, sample] of Object.entries(tick.sessions)) {
        const prior = pending[id];
        pending[id] = {
          bytes: (prior?.bytes ?? 0) + sample.bytes,
          lastLine: sample.lastLine ?? prior?.lastLine ?? null
        };
      }
    });
    const offConnection = bridge.onConnection((info) => {
      const was = useLive.getState().connection.state;
      useLive.getState().setConnection(info);
      if (info.state === 'online' && was !== 'online') {
        void client.invalidateQueries();
        void seed();
      }
    });
    const offCommand = bridge.onCommand((command) => commandRef.current(command));
    void bridge.connection().then((info) => {
      useLive.getState().setConnection(info);
      if (info.state === 'online') void seed();
    });
    return () => {
      clearInterval(clock);
      offEvent();
      offActivity();
      offConnection();
      offCommand();
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [client]);
}
