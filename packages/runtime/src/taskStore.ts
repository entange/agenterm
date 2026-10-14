import type { TaskRecord } from '@agenterm/core';
import type { TaskTable } from './database.js';

/**
 * Tasks in memory, mirrored to SQLite when a table is given. Reads never
 * touch the database; it is loaded once at startup.
 */
export class TaskStore {
  private readonly tasks = new Map<string, TaskRecord>();

  constructor(private readonly table?: TaskTable | undefined) {
    for (const task of table?.list() ?? []) this.tasks.set(task.id, task);
  }

  get(id: string): TaskRecord | null {
    return this.tasks.get(id) ?? null;
  }

  /** Newest first. */
  list(): TaskRecord[] {
    return [...this.tasks.values()].sort((a, b) => b.startedAtMs - a.startedAtMs);
  }

  put(task: TaskRecord): TaskRecord {
    this.tasks.set(task.id, task);
    try {
      this.table?.put(task);
    } catch {
      // The in-memory copy is the source of truth while the daemon runs.
    }
    return task;
  }

  delete(id: string): void {
    this.tasks.delete(id);
    try {
      this.table?.delete(id);
    } catch {
      // Same as put.
    }
  }
}
