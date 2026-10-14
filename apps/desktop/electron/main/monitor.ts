import { statusText, type AgentermEvent, type TaskRecord } from '@agenterm/core';
import { Notification } from 'electron';
import { taskLabel } from '../../shared/label.js';
import type { DaemonLink } from './daemonLink.js';

/**
 * Keeps main's copy of the task list for the tray, and
 * raises a native notification when a running task fails, but only while
 * no agenterm window has focus. Tasks someone stopped never notify.
 */
export class TaskMonitor {
  private tasks: TaskRecord[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly poll: ReturnType<typeof setInterval>;

  constructor(
    private readonly options: {
      link: DaemonLink;
      enabled: () => boolean;
      hasFocus: () => boolean;
      onOpenTask: (taskId: string) => void;
      onTasks: (tasks: TaskRecord[]) => void;
    }
  ) {
    options.link.onEvent((event) => this.handle(event));
    options.link.onConnection((info) => {
      if (info.state === 'online') this.scheduleRefresh(0);
    });
    this.poll = setInterval(() => this.scheduleRefresh(0), 10_000);
  }

  list(): TaskRecord[] {
    return this.tasks;
  }

  private handle(event: AgentermEvent): void {
    if (event.kind === 'terminal.output') return;
    this.scheduleRefresh(1000);
    if (event.kind !== 'task.updated') return;
    const before = this.tasks.find((task) => task.id === event.taskId);
    if (before?.status === 'running' && event.task.status === 'failed') {
      this.notify(event.task);
    }
    if (before !== undefined) this.tasks = this.tasks.map((task) => (task.id === event.taskId ? event.task : task));
  }

  private notify(task: TaskRecord): void {
    if (!this.options.enabled() || this.options.hasFocus() || !Notification.isSupported()) return;
    const notification = new Notification({ title: `${taskLabel(task)} ${statusText(task)}`, body: task.command });
    notification.on('click', () => this.options.onOpenTask(task.id));
    notification.show();
  }

  private scheduleRefresh(delayMs: number): void {
    if (this.refreshTimer !== null) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, delayMs);
  }

  private async refresh(): Promise<void> {
    if (this.options.link.connection().state !== 'online') return;
    try {
      this.tasks = (await this.options.link.client().listTasks()).tasks;
    } catch {
      return;
    }
    this.options.onTasks(this.tasks);
  }

  dispose(): void {
    clearInterval(this.poll);
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
  }
}
