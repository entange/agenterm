import type { AgentermEvent, SessionRecord } from '@agenterm/core';
import { app, Notification } from 'electron';
import { callsign } from '../../shared/callsign.js';
import type { DaemonLink } from './daemonLink.js';

/**
 * Watches daemon events for moments that need the user.
 *
 * Raises a native notification when an agent waits for approval or a
 * reply, reports failure or completion, or exits badly, but only while
 * no agenterm window has focus. Keeps the dock badge equal to the number
 * of live agents waiting on the user, and hands the latest session list
 * to the tray.
 */
export class AttentionMonitor {
  private sessions: SessionRecord[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly poll: ReturnType<typeof setInterval>;
  /** Avoid repeating the same notification while a status flaps. */
  private readonly lastNotified = new Map<string, string>();

  constructor(
    private readonly options: {
      link: DaemonLink;
      enabled: () => boolean;
      hasFocus: () => boolean;
      onOpenSession: (sessionId: string) => void;
      onSessions: (sessions: SessionRecord[]) => void;
    }
  ) {
    options.link.onEvent((event) => this.handle(event));
    options.link.onConnection((info) => {
      if (info.state === 'online') this.scheduleRefresh(0);
    });
    this.poll = setInterval(() => this.scheduleRefresh(0), 10_000);
  }

  list(): SessionRecord[] {
    return this.sessions;
  }

  private find(sessionId: string): SessionRecord | undefined {
    return this.sessions.find((session) => session.id === sessionId);
  }

  private handle(event: AgentermEvent): void {
    if (event.kind === 'terminal.output' || event.kind === 'terminal.input' || event.kind === 'file.changed') return;
    this.scheduleRefresh(300);
    const session = this.find(event.sessionId);
    const name = session === undefined ? 'An agent' : `${callsign(session)} · ${session.title}`;
    if (event.kind === 'agent.status' && event.overlay === 'working') {
      // Back at work: the next wait is a new moment worth announcing.
      this.lastNotified.delete(event.sessionId);
      return;
    }
    if (event.kind === 'agent.status') {
      const messages: Partial<Record<typeof event.overlay, string>> = {
        waiting_permission: 'Waiting for your approval',
        waiting_input: 'Waiting for your reply',
        failed: 'Reported a failure',
        completed: 'Finished its task'
      };
      const body = messages[event.overlay];
      if (body !== undefined) this.notify(event.sessionId, `status:${event.overlay}`, name, event.summary ?? body);
      return;
    }
    if (event.kind === 'session.exited' && session?.lifecycle !== 'killed') {
      const bad = event.exitSignal !== null || (event.exitCode !== null && event.exitCode !== 0);
      if (bad) {
        const detail =
          event.exitSignal !== null ? `Ended by ${event.exitSignal}` : `Exited with code ${event.exitCode}`;
        this.notify(event.sessionId, `exit:${event.createdAtMs}`, name, detail);
      }
    }
  }

  private notify(sessionId: string, key: string, title: string, body: string): void {
    if (!this.options.enabled() || this.options.hasFocus() || !Notification.isSupported()) return;
    if (this.lastNotified.get(sessionId) === key) return;
    this.lastNotified.set(sessionId, key);
    const notification = new Notification({ title, body, silent: false });
    notification.on('click', () => this.options.onOpenSession(sessionId));
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
      this.sessions = (await this.options.link.client().listSessions()).sessions;
    } catch {
      return;
    }
    const waiting = this.sessions.filter(
      (session) =>
        session.lifecycle === 'running' &&
        (session.overlay === 'waiting_permission' ||
          session.overlay === 'waiting_input' ||
          session.overlay === 'failed')
    ).length;
    if (process.platform === 'darwin' || process.platform === 'linux') app.setBadgeCount(waiting);
    this.options.onSessions(this.sessions);
  }

  dispose(): void {
    clearInterval(this.poll);
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
  }
}
