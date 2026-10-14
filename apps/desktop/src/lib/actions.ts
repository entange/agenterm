import type { QueryClient } from '@tanstack/react-query';
import { isRunning, type TaskRecord } from '@agenterm/core';
import { api } from './bridge.js';
import { useLive } from './live.js';
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

export function copyText(text: string, label: string): void {
  void navigator.clipboard.writeText(text).then(
    () => toast('success', `Copied ${label}`),
    (error: unknown) => toastError(`Could not copy ${label}`, error)
  );
}
