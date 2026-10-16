import type { OutsideProcess, TaskRecord } from '@agenterm/core';
import { useQuery } from '@tanstack/react-query';
import { api } from './bridge.js';
import { useLive } from './live.js';
import { sortTasks } from './tasks.js';

export const keys = {
  tasks: ['tasks'] as const,
  settings: ['settings'] as const,
  health: ['health'] as const,
  processes: ['processes'] as const
};

function useOnline(): boolean {
  return useLive((state) => state.connection.state === 'online');
}

/** Every task, running first. Events patch this cache in place; the poll is a safety net. */
export function useTasks() {
  const online = useOnline();
  return useQuery({
    queryKey: keys.tasks,
    queryFn: async (): Promise<TaskRecord[]> => sortTasks((await api('listTasks')).tasks),
    enabled: online,
    refetchInterval: 15_000,
    placeholderData: (previous) => previous
  });
}

export function useSettings(enabled = true) {
  const online = useOnline();
  return useQuery({ queryKey: keys.settings, queryFn: () => api('settings'), enabled: online && enabled });
}

export function useHealth(enabled = true) {
  const online = useOnline();
  return useQuery({
    queryKey: keys.health,
    queryFn: () => api('health'),
    enabled: online && enabled,
    refetchInterval: 5000
  });
}

/**
 * Commands running outside agenterm. Each scan reads the whole process
 * table, so it polls often only while the list is on screen.
 */
export function useOutside(visible: boolean) {
  const online = useOnline();
  return useQuery({
    queryKey: keys.processes,
    queryFn: async (): Promise<OutsideProcess[]> => (await api('listProcesses')).processes,
    enabled: online,
    refetchInterval: visible ? 4000 : 60_000,
    placeholderData: (previous) => previous
  });
}
