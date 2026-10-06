import type { SessionRecord } from '@agenterm/core';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { attentionOf, acknowledgementKey, type Attention } from '../../shared/attention.js';
import { api } from './bridge.js';
import { useLive } from './live.js';
import { useUi } from './ui.js';

export const keys = {
  sessions: ['sessions'] as const,
  detail: (id: string) => ['detail', id] as const,
  commands: (id: string) => ['commands', id] as const,
  git: (id: string) => ['git', id] as const,
  diff: (id: string, path: string) => ['diff', id, path] as const,
  files: (id: string) => ['files', id] as const,
  processes: (id: string) => ['processes', id] as const,
  events: (id: string | null) => ['events', id] as const,
  discover: ['discover'] as const
};

function useOnline(): boolean {
  return useLive((state) => state.connection.state === 'online');
}

export function useSessions() {
  const online = useOnline();
  return useQuery({
    queryKey: keys.sessions,
    queryFn: async () => (await api('listSessions')).sessions,
    enabled: online,
    refetchInterval: 15_000,
    placeholderData: (previous) => previous
  });
}

export function useSession(id: string | null): SessionRecord | null {
  const { data } = useSessions();
  return id === null ? null : (data?.find((session) => session.id === id) ?? null);
}

export function useCommands(id: string, enabled = true) {
  const online = useOnline();
  return useQuery({
    queryKey: keys.commands(id),
    queryFn: async () => (await api('commands', id, { limit: 200 })).commands,
    enabled: online && enabled,
    refetchInterval: 4000
  });
}

export function useGit(id: string, enabled = true) {
  const online = useOnline();
  return useQuery({
    queryKey: keys.git(id),
    queryFn: () => api('git', id),
    enabled: online && enabled,
    refetchInterval: 20_000
  });
}

export function useDiff(id: string, path: string | null) {
  const online = useOnline();
  return useQuery({
    queryKey: keys.diff(id, path ?? ''),
    queryFn: () => api('gitDiff', id, path ?? ''),
    enabled: online && path !== null
  });
}

export function useFiles(id: string, enabled = true) {
  const online = useOnline();
  return useQuery({ queryKey: keys.files(id), queryFn: () => api('files', id), enabled: online && enabled });
}

export function useProcesses(id: string, enabled = true) {
  const online = useOnline();
  return useQuery({
    queryKey: keys.processes(id),
    queryFn: async () => {
      const [processes, ports] = await Promise.all([api('processes', id), api('ports', id)]);
      return { processes: processes.processes, ports: ports.ports };
    },
    enabled: online && enabled,
    refetchInterval: 3000
  });
}

export function useDiscover(enabled = true) {
  const online = useOnline();
  return useQuery({
    queryKey: keys.discover,
    queryFn: async () => (await api('discover')).candidates,
    enabled: online && enabled,
    refetchInterval: 10_000
  });
}

/**
 * Attention for every session. Recomputed when the list, the working set,
 * acknowledgements, or the 30-second clock change; never on every tick,
 * which would re-render the whole app each second with hundreds of agents.
 */
export function useAttention(sessions: SessionRecord[] | undefined): Map<string, Attention> {
  const workingKey = useLive((state) => state.workingKey);
  const clock = useLive((state) => state.clock);
  const acknowledged = useUi((state) => state.acknowledged);
  return useMemo(() => {
    const lastOutputAt = useLive.getState().lastOutputAt;
    const seen = new Set(acknowledged);
    const now = Math.max(Date.now(), clock);
    const out = new Map<string, Attention>();
    for (const session of sessions ?? []) {
      out.set(
        session.id,
        attentionOf(session, {
          nowMs: now,
          lastOutputAtMs: lastOutputAt[session.id],
          acknowledged: seen.has(acknowledgementKey(session))
        })
      );
    }
    return out;
    // workingKey stands in for lastOutputAt membership, which is read fresh above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, workingKey, clock, acknowledged]);
}

/**
 * Put a just-created session into the cached list so selecting it does not
 * race the refetch (the list would briefly not contain it).
 */
export function seedSession(client: QueryClient, session: SessionRecord): void {
  client.setQueryData<SessionRecord[]>(keys.sessions, (current) => [
    session,
    ...(current ?? []).filter((entry) => entry.id !== session.id)
  ]);
}

/** Refresh everything after reconnecting or a bulk change. */
export function refreshAll(client: QueryClient): void {
  void client.invalidateQueries();
}
