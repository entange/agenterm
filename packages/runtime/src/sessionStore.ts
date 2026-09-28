import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentProvider, ListSessionsQuery, SessionRecord } from '@agenterm/core';

/**
 * Session store.
 *
 * In-memory index with per-session metadata.json files under the data dir.
 * Writes the metadata file on every mutation so a daemon restart can
 * replay rows and mark live sessions crashed. Attached rows and spawned
 * rows share the SessionRecord contract.
 */
export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly dataDir: string | undefined;

  constructor(options: { dataDir?: string | undefined } = {}) {
    this.dataDir = options.dataDir;
  }

  private persist(record: SessionRecord): void {
    if (this.dataDir === undefined) return;
    try {
      const dir = path.join(this.dataDir, 'sessions', record.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(record, null, 2), 'utf8');
    } catch {
      // Persistence is best effort; memory stays authoritative.
    }
  }

  createAttached(input: {
    pid: number;
    commandLine: string;
    cwd: string;
    title?: string | undefined;
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
    this.persist(record);
    return record;
  }

  createSpawned(input: {
    id?: string | undefined;
    provider: AgentProvider;
    agentId: string;
    title: string;
    cwd: string;
    worktreeRoot: string | null;
    branch: string | null;
    commandLine: string[];
    resolvedBinaryPath: string | null;
    pid: number;
    cols: number;
    rows: number;
  }): SessionRecord {
    const now = Date.now();
    const record: SessionRecord = {
      id: input.id ?? crypto.randomUUID(),
      agentId: input.agentId,
      provider: input.provider,
      title: input.title,
      cwd: input.cwd,
      worktreeRoot: input.worktreeRoot,
      branch: input.branch,
      origin: 'spawned',
      commandLine: input.commandLine,
      resolvedBinaryPath: input.resolvedBinaryPath,
      pid: input.pid,
      lifecycle: 'running',
      overlay: 'unknown',
      overlaySource: 'pty',
      cols: input.cols,
      rows: input.rows,
      startedAtMs: now,
      endedAtMs: null,
      exitCode: null,
      exitSignal: null
    };
    this.sessions.set(record.id, record);
    this.persist(record);
    return record;
  }

  markExited(id: string, exitCode: number | null, exitSignal: string | null): SessionRecord | null {
    const record = this.sessions.get(id);
    if (record === undefined) return null;
    if (record.lifecycle === 'exited' || record.lifecycle === 'killed') return record;
    const updated: SessionRecord = {
      ...record,
      lifecycle: 'exited',
      endedAtMs: Date.now(),
      exitCode,
      exitSignal
    };
    this.sessions.set(id, updated);
    this.persist(updated);
    return updated;
  }

  markKilled(id: string): SessionRecord | null {
    const record = this.sessions.get(id);
    if (record === undefined) return null;
    const updated: SessionRecord = {
      ...record,
      lifecycle: 'killed',
      endedAtMs: Date.now()
    };
    this.sessions.set(id, updated);
    this.persist(updated);
    return updated;
  }

  setDims(id: string, cols: number, rows: number): SessionRecord | null {
    const record = this.sessions.get(id);
    if (record === undefined) return null;
    const updated: SessionRecord = { ...record, cols, rows };
    this.sessions.set(id, updated);
    this.persist(updated);
    return updated;
  }

  /** Remove a row after detach or kill-tree. Returns the removed row. */
  remove(id: string): SessionRecord | null {
    const record = this.sessions.get(id);
    if (record === undefined) return null;
    this.sessions.delete(id);
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
