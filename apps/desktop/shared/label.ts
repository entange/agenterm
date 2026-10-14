import type { TaskRecord } from '@agenterm/core';

/**
 * What to call a task on screen: its title when someone gave it one,
 * otherwise its id ("web", "npm-run-dev-3f9a"). The command is shown
 * beside it anyway, so repeating it as the name adds nothing.
 */
export function taskLabel(task: Pick<TaskRecord, 'id' | 'title' | 'command'>): string {
  return task.title !== task.command ? task.title : task.id;
}
