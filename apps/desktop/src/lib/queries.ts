import type { TaskRecord } from '@agenterm/core';
import { useQuery } from '@tanstack/react-query';
import { api } from './bridge.js';
import { useLive } from './live.js';
import { sortTasks } from './tasks.js';

export const keys = {
  tasks: ['tasks'] as const,
  settings: ['settings'] as const,
  health: ['health'] as const
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
