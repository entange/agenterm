import type { SessionRecord, SpawnSessionRequest } from '@agenterm/core';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { callsign } from '../../shared/callsign.js';
import { api } from './bridge.js';
import { keys } from './queries.js';
import { toast, toastError } from './toast.js';
import { useUi } from './ui.js';

/**
 * User actions. Each one names its result the way its button names the
 * action ("Kill" → "Killed"), refreshes what it changed, and reports
 * daemon errors with their hint.
 */
export function actions(client: QueryClient) {
  const refresh = (id?: string): void => {
    void client.invalidateQueries({ queryKey: keys.sessions });
    if (id !== undefined) void client.invalidateQueries({ queryKey: keys.detail(id) });
  };

  return {
    async spawn(request: SpawnSessionRequest): Promise<SessionRecord | null> {
      try {
        const { session } = await api('spawn', request);
        refresh();
        useUi.getState().rememberCwd(request.cwd);
        useUi.getState().select(session.id, 'terminal');
        toast('success', `Started ${callsign(session)}`, session.title);
        return session;
      } catch (error) {
        toastError('Could not start the session', error);
        return null;
      }
    },

    async attach(pid: number, title?: string): Promise<void> {
      try {
        const { session } = await api('attach', { pid, cwd: null, ...(title === undefined ? {} : { title }) });
        refresh();
        useUi.getState().select(session.id, 'processes');
        toast('success', `Attached to pid ${pid}`, 'Watching read-only. agenterm will not type into or stop it.');
      } catch (error) {
        toastError(`Could not attach to pid ${pid}`, error);
      }
    },

    async interrupt(session: SessionRecord): Promise<void> {
      try {
        await api('signal', session.id, { signal: 'interrupt' });
      } catch (error) {
        toastError('Could not send Ctrl+C', error);
      }
    },

    async kill(session: SessionRecord, confirmPid?: number): Promise<boolean> {
      try {
        const result = await api('deleteSession', session.id, {
          killTree: true,
          ...(confirmPid === undefined ? {} : { confirmPid })
        });
        refresh(session.id);
        toast('success', result.killed ? `Killed ${callsign(session)}` : `${callsign(session)} had already ended`);
        return true;
      } catch (error) {
        toastError(`Could not kill ${callsign(session)}`, error);
        return false;
      }
    },

    async close(session: SessionRecord): Promise<void> {
      try {
        await api('deleteSession', session.id, { killTree: false });
        if (useUi.getState().selectedId === session.id) useUi.getState().select(null);
        refresh();
        toast('info', session.origin === 'attached' ? `Detached from pid ${session.pid}` : `Closed ${callsign(session)}`);
      } catch (error) {
        toastError(`Could not close ${callsign(session)}`, error);
      }
    },

    async restart(session: SessionRecord): Promise<void> {
      try {
        const { session: fresh } = await api('restart', session.id);
        refresh();
        useUi.getState().select(fresh.id, 'terminal');
        toast('success', `Restarted as ${callsign(fresh)}`);
      } catch (error) {
        toastError(`Could not restart ${callsign(session)}`, error);
      }
    },

    async rename(session: SessionRecord, title: string): Promise<void> {
      try {
        await api('updateSession', session.id, { title });
        refresh(session.id);
      } catch (error) {
        toastError('Could not rename the session', error);
      }
    }
  };
}

export type Actions = ReturnType<typeof actions>;


export function useActions(): Actions {
  const client = useQueryClient();
  return useMemo(() => actions(client), [client]);
}
