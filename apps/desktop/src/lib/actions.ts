import type { QueryClient } from '@tanstack/react-query';
import { isRunning, type OutsideProcess, type TaskRecord } from '@agenterm/core';
import { api } from './bridge.js';
import { useLive } from './live.js';
import { canMove, taskIdFor } from './outside.js';
import { keys } from './queries.js';
import { upsertTask } from './tasks.js';
import { toast, toastError } from './toast.js';
import { useUi } from './ui.js';

/**
 * What the app can do to a task: stop it, kill it, remove it, clear the
 * ended ones. Results go straight into the cached list so the screen
 * updates before the next event arrives.
 */

function patch(client: QueryClient, task: TaskRecord): void {
  client.setQueryData<TaskRecord[]>(keys.tasks, (current) => upsertTask(current ?? [], task));
}

function drop(client: QueryClient, ids: string[]): void {
  const gone = new Set(ids);
  client.setQueryData<TaskRecord[]>(keys.tasks, (current) => (current ?? []).filter((task) => !gone.has(task.id)));
  for (const id of ids) useLive.getState().forget(id);
}

/** Ctrl+C, then end the process tree if it does not exit. `force` kills it right away. */
export async function stopTask(client: QueryClient, task: TaskRecord, force: boolean): Promise<void> {
  try {
    patch(client, (await api('stop', task.id, { force })).task);
  } catch (error) {
    toastError(force ? `Could not kill ${task.id}` : `Could not stop ${task.id}`, error);
  }
}

async function removeNow(client: QueryClient, task: TaskRecord): Promise<void> {
  try {
    await api('remove', task.id);
    drop(client, [task.id]);
  } catch (error) {
    toastError(`Could not remove ${task.id}`, error);
  }
}

/** Remove a task and its output. A running one is stopped first, after asking. */
export function removeTask(client: QueryClient, task: TaskRecord): void {
  if (!isRunning(task)) {
    void removeNow(client, task);
    return;
  }
  useUi.getState().confirm({
    title: `Stop and remove ${task.id}?`,
    detail: `${task.command} is still running. It will be stopped and its output deleted.`,
    action: 'Stop and remove',
    run: () => removeNow(client, task)
  });
}

/** Remove every task that has ended. */
export async function clearEnded(client: QueryClient): Promise<void> {
  try {
    const { removed } = await api('clearEnded');
    drop(client, removed);
    toast(
      'success',
      removed.length === 0
        ? 'Nothing to clear'
        : `Cleared ${removed.length} ended ${removed.length === 1 ? 'task' : 'tasks'}`
    );
  } catch (error) {
    toastError('Could not clear ended tasks', error);
  }
}

/**
 * End a command running outside agenterm and everything under it, after
 * asking: agenterm did not start it, so it may be someone's work.
 */
export function stopOutside(client: QueryClient, entry: OutsideProcess, force: boolean): void {
  const others = entry.pids.length - 1;
  const starter = entry.orphaned
    ? 'What started it has exited.'
    : `${entry.startedBy ?? 'Something'} started it and is still running.`;
  const how = force ? 'It is killed right away' : 'It gets SIGTERM, then SIGKILL after 3 seconds';
  const under = others > 0 ? `, with the ${others} ${others === 1 ? 'process' : 'processes'} under it` : '';
  useUi.getState().confirm({
    title: `${force ? 'Kill' : 'Stop'} ${entry.name} (pid ${entry.pid})?`,
    detail: `${starter} ${how}${under}.`,
    action: force ? 'Kill' : 'Stop',
    run: async () => {
      try {
        const { exited } = await api('stopProcess', entry.pid, { force, startedAtMs: entry.startedAtMs });
        if (exited) toast('success', `Ended ${entry.name}`);
        else toast('error', `${entry.name} is still running`, 'Some of its processes ignored the signal. Try Kill.');
      } catch (error) {
        toastError(`Could not end ${entry.name}`, error);
      } finally {
        await client.invalidateQueries({ queryKey: keys.processes });
      }
    }
  });
}

/**
 * Restart a command from outside agenterm as a task, so its output shows
 * here: stop it, then run the same command in the same folder. Asks first,
 * since anything the command holds in memory is lost.
 */
export function moveOutside(client: QueryClient, entry: OutsideProcess): void {
  if (!canMove(entry)) return;
  const id = taskIdFor(entry);
  useUi.getState().confirm({
    title: `Move ${entry.name} into agenterm?`,
    detail: `This restarts it. It is stopped now and started again as the task ${id}, with the same command in ${entry.cwd}, so you can watch its output and type into it. Anything it only keeps in memory is lost.`,
    action: 'Restart in agenterm',
    run: async () => {
      try {
        const { exited } = await api('stopProcess', entry.pid, { startedAtMs: entry.startedAtMs });
        if (!exited) {
          toast(
            'error',
            `${entry.name} is still running`,
            'Some of its processes ignored the signal, so it was not restarted.'
          );
          return;
        }
        const { task } = await api('run', { id, command: entry.command, cwd: entry.cwd });
        patch(client, task);
        useUi.getState().select(task.id);
        toast('success', `Moved ${entry.name} into agenterm as ${task.id}`);
      } catch (error) {
        toastError(`Could not move ${entry.name}`, error);
      } finally {
        await client.invalidateQueries({ queryKey: keys.processes });
      }
    }
  });
}

export function copyText(text: string, label: string): void {
  void navigator.clipboard.writeText(text).then(
    () => toast('success', `Copied ${label}`),
    (error: unknown) => toastError(`Could not copy ${label}`, error)
  );
}
