import type { OutsideProcess } from '@agenterm/core';
import { Notification } from 'electron';
import type { DaemonLink } from './daemonLink.js';

/** A command that became orphaned since the last look, and who had started it. */
export interface NewOrphan {
  entry: OutsideProcess;
  /** The terminal or agent that exited, when an earlier look saw it. */
  leftBy: string | null;
}

const keyOf = (entry: OutsideProcess): string => `${entry.pid}:${entry.startedAtMs}`;

/**
 * Orphans in `current` that were not orphans before: ones whose terminal
 * or agent exited since `previous`, and ones that showed up orphaned. Hidden
 * commands never count.
 */
export function newOrphans(previous: Map<string, OutsideProcess>, current: OutsideProcess[]): NewOrphan[] {
  return current
    .filter((entry) => entry.orphaned && !entry.hidden && previous.get(keyOf(entry))?.orphaned !== true)
    .map((entry) => ({ entry, leftBy: previous.get(keyOf(entry))?.startedBy ?? null }));
}

/** The notification for new orphans: one names the command, several name who left them. */
export function orphanMessage(found: NewOrphan[]): { title: string; body: string } {
  const starters = [...new Set(found.map((orphan) => orphan.leftBy).filter((name) => name !== null))];
  const exited = starters.length > 0 ? `${starters.join(' and ')} exited` : 'What started it exited';
  const first = found[0];
  if (found.length === 1 && first !== undefined) {
    const { entry } = first;
    const port = entry.ports.length > 0 ? ` It holds :${entry.ports.join(' :')}.` : '';
    return { title: `${entry.name} was left running`, body: `${exited}, and nothing will stop it.${port}` };
  }
  const names = [...new Set(found.map((orphan) => orphan.entry.name))];
  return {
    title: `${found.length} commands were left running`,
    body: `${starters.length > 0 ? exited : 'What started them exited'}: ${names.slice(0, 4).join(', ')}${names.length > 4 ? ', …' : ''}.`
  };
}

/**
 * Looks at what runs outside agenterm every 15 seconds and raises a
 * notification when something is newly orphaned and still there on the
 * next look, so short-lived helpers never notify. The first look only sets
 * what counts as already known.
 */
export class OrphanWatcher {
  private seen: Map<string, OutsideProcess> | null = null;
  private pending: NewOrphan[] = [];
  private orphans: OutsideProcess[] = [];
  private readonly poll: ReturnType<typeof setInterval>;
  private busy = false;

  constructor(
    private readonly options: {
      link: DaemonLink;
      enabled: () => boolean;
      hasFocus: () => boolean;
      onOpen: (pid: number) => void;
      onOrphans: (orphans: OutsideProcess[]) => void;
    }
  ) {
    options.link.onConnection((info) => {
      if (info.state === 'online') void this.look();
    });
    this.poll = setInterval(() => void this.look(), 15_000);
  }

  /** Orphans as of the last look, hidden ones left out. */
  list(): OutsideProcess[] {
    return this.orphans;
  }

  private async look(): Promise<void> {
    if (this.busy || this.options.link.connection().state !== 'online') return;
    this.busy = true;
    try {
      const { processes } = await this.options.link.client().listProcesses();
      const current = new Map(processes.map((entry) => [keyOf(entry), entry]));
      const still = (orphan: NewOrphan): boolean => {
        const entry = current.get(keyOf(orphan.entry));
        return entry !== undefined && entry.orphaned && !entry.hidden;
      };
      this.notify(this.pending.filter(still));
      this.pending = this.seen === null ? [] : newOrphans(this.seen, processes);
      this.seen = current;
      const orphans = processes.filter((entry) => entry.orphaned && !entry.hidden);
      const changed =
        orphans.length !== this.orphans.length || orphans.some((entry, i) => entry.pid !== this.orphans[i]?.pid);
      this.orphans = orphans;
      if (changed) this.options.onOrphans(orphans);
    } catch {
      // An older daemon, or one going away: try again on the next look.
    } finally {
      this.busy = false;
    }
  }

  private notify(found: NewOrphan[]): void {
    const first = found[0];
    if (first === undefined) return;
    if (!this.options.enabled() || this.options.hasFocus() || !Notification.isSupported()) return;
    const notification = new Notification(orphanMessage(found));
    notification.on('click', () => this.options.onOpen(first.entry.pid));
    notification.show();
  }

  dispose(): void {
    clearInterval(this.poll);
  }
}
