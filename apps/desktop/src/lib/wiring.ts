import type { AgentermEvent } from '@agenterm/core';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import type { AppCommand } from '../../shared/bridge.js';
import { api, getBridge } from './bridge.js';
import { useLive } from './live.js';
import { keys } from './queries.js';

/**
 * Connect the renderer to main once: connection state, heartbeat ticks,
 * the activity feed, and targeted cache invalidation per event so views
 * update the moment the daemon reports a change.
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
        case 'session.exited':
        case 'session.updated':
        case 'agent.status':
        case 'workspace.conflict':
          later('sessions', 60, () => invalidate(keys.sessions));
          invalidate(keys.detail(id));
          break;
        case 'session.detached':
          later('sessions', 60, () => invalidate(keys.sessions));
          live.forget(id);
          break;
        case 'port.opened':
        case 'port.closed':
          invalidate(keys.processes(id));
          invalidate(keys.detail(id));
          break;
        case 'file.changed':
          later(`files:${id}`, 250, () => invalidate(keys.files(id)));
          later(`git:${id}`, 900, () => {
            invalidate(keys.git(id));
            invalidate(['diff', id]);
          });
          break;
        default:
          break;
      }
    };

    const offEvent = bridge.onEvent(onEvent);
    const offActivity = bridge.onActivity((tick) => useLive.getState().applyTick(tick));
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
      offEvent();
      offActivity();
      offConnection();
      offCommand();
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [client]);
}
