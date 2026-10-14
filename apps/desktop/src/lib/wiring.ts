import type { AgentermEvent, TaskRecord } from '@agenterm/core';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import type { AppCommand } from '../../shared/bridge.js';
import { api, getBridge } from './bridge.js';
import { useLive } from './live.js';
import { keys } from './queries.js';
import { upsertTask } from './tasks.js';

/** Apply a task event to the cached list in place, so hundreds of tasks never refetch per event. */
export function applyTaskEvent(client: QueryClient, event: AgentermEvent): void {
  if (event.kind === 'terminal.output') return;
  const current = client.getQueryData<TaskRecord[]>(keys.tasks);
  if (current === undefined) {
    void client.invalidateQueries({ queryKey: keys.tasks });
    return;
  }
  if (event.kind === 'task.updated') {
    client.setQueryData<TaskRecord[]>(keys.tasks, upsertTask(current, event.task));
    return;
  }
  client.setQueryData<TaskRecord[]>(
    keys.tasks,
    current.filter((task) => task.id !== event.taskId)
  );
  useLive.getState().forget(event.taskId);
}

/** Connect the renderer to main once: connection state, task events, output lines, and app commands. */
export function useDaemonWiring(onCommand: (command: AppCommand) => void): void {
  const client = useQueryClient();
  // Commands arrive through a ref so a new handler never re-subscribes the bridge.
  const commandRef = useRef(onCommand);
  commandRef.current = onCommand;

  useEffect(() => {
    const bridge = getBridge();
    if (bridge === null) return undefined;
    const seed = (): void => {
      void api('activity')
        .then((snapshot) => useLive.getState().seedActivity(snapshot))
        .catch(() => undefined);
    };
    const offEvent = bridge.onEvent((event) => applyTaskEvent(client, event));
    const offActivity = bridge.onActivity((tick) => useLive.getState().applyTick(tick));
    const offConnection = bridge.onConnection((info) => {
      const was = useLive.getState().connection.state;
      useLive.getState().setConnection(info);
      if (info.state === 'online' && was !== 'online') {
        void client.invalidateQueries();
        seed();
      }
    });
    const offCommand = bridge.onCommand((command) => commandRef.current(command));
    void bridge.connection().then((info) => {
      useLive.getState().setConnection(info);
      if (info.state === 'online') seed();
    });
    return () => {
      offEvent();
      offActivity();
      offConnection();
      offCommand();
    };
  }, [client]);
}
