import crypto from 'node:crypto';
import type { ListSessionsQuery, SessionRecord } from '@agenterm/core';

/**
 * Early session store.
 *
 * In-memory index plus per-session metadata.json files under the data dir.
 * The full relational design with drizzle-orm arrives with the spawn change;
 * this interface already matches the SessionRecord contract so callers do
 * not break when storage moves.
 */
export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  createAttached(input: {
    pid: number;
    commandLine: string;
    cwd: string;
    title?: string;
    worktreeRoot?: string | null;
    branch?: string | null;
  }): SessionRecord {
    const id = crypto.randomUUID();
    const now = Date.now();
    const title =
      input.title !== undefined && input.title.trim().length > 0
        ? input.title.trim().slice(0, 200)
        : `attached ${input.pid}`;
    const record: SessionRecord = {
      id,
      agentId: 'attached',
      provider: 'generic',
      title,
      cwd: input.cwd,
      worktreeRoot: input.worktreeRoot ?? null,
      branch: input.branch ?? null,
      origin: 'attached',
      commandLine: input.commandLine.split(' ').filter((part) => part.length > 0),
      resolvedBinaryPath: null,
      pid: input.pid,
      lifecycle: 'running',
      overlay: 'unknown',
      overlaySource: 'pty',
      cols: 80,
      rows: 24,
      startedAtMs: now,
      endedAtMs: null,
      exitCode: null,
      exitSignal: null
    };
    this.sessions.set(id, record);
    return record;
  }

  get(id: string): SessionRecord | null {
    return this.sessions.get(id) ?? null;
  }

  list(query: ListSessionsQuery = {}): SessionRecord[] {
    const out: SessionRecord[] = [];
    for (const record of this.sessions.values()) {
      if (query.provider !== undefined && record.provider !== query.provider) continue;
      if (query.lifecycle !== undefined && record.lifecycle !== query.lifecycle) continue;
      if (query.overlay !== undefined && record.overlay !== query.overlay) continue;
      if (query.cwd !== undefined && record.cwd !== query.cwd) continue;
      out.push(record);
    }
    out.sort((a, b) => b.startedAtMs - a.startedAtMs);
    return out;
  }

  hasPid(pid: number): boolean {
    for (const record of this.sessions.values()) {
      if (record.pid === pid) return true;
    }
    return false;
  }

  clear(): void {
    this.sessions.clear();
  }
}
