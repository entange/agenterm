import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentProvider, ListSessionsQuery, SessionRecord } from '@agenterm/core';
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, type SqliteSessions } from './database.js';

/** Lifecycles where the leader process may still be running. */
const LIVE_LIFECYCLES: ReadonlySet<SessionRecord['lifecycle']> = new Set(['created', 'starting', 'running']);

/** True when the row says the leader may still be running. */
export function isLiveSession(record: SessionRecord): boolean {
  return LIVE_LIFECYCLES.has(record.lifecycle);
}

/**
 * Session store.
 *
 * In-memory index with write-through to metadata.json files plus the
 * SQLite sessions table when adapters are present. Metadata files keep
 * per-session debug truth; SQLite is the queryable record. On open with
 * an adapter, existing rows load into memory and rows left live are
 * marked crashed. Attached rows and spawned rows share the contract.
 */
export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly dataDir: string | undefined;
  private readonly table: SqliteSessions | undefined;

  constructor(options: { dataDir?: string | undefined; table?: SqliteSessions | undefined } = {}) {
    this.dataDir = options.dataDir;
    this.table = options.table;
    if (this.table !== undefined) {
      const crashed = this.table.replayCrashes(Date.now());
      void crashed;
      for (const record of this.table.all()) {
        this.sessions.set(record.id, record);
      }
    }
  }

  private persist(record: SessionRecord): void {
    if (this.table !== undefined) {
      try {
        this.table.save(record);
      } catch {
        // SQLite stays best effort; memory is authoritative.
      }
    }
    if (this.dataDir === undefined) return;
    try {
      const dir = path.join(this.dataDir, 'sessions', record.id);
      fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
      fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(record, null, 2), {
        encoding: 'utf8',
        mode: PRIVATE_FILE_MODE
      });
    } catch {
      // Persistence is best effort; memory stays authoritative.
    }
  }

  createAttached(input: {
    pid: number;
    commandLine: string;
    cwd: string;
    provider?: AgentProvider | undefined;
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
      agentId: input.provider ?? 'attached',
      provider: input.provider ?? 'generic',
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

  /**
   * Record PTY exit truth. A row already marked killed by the user keeps
   * that lifecycle but still gains the real exit code and signal.
   */
  markExited(id: string, exitCode: number | null, exitSignal: string | null): SessionRecord | null {
    const record = this.sessions.get(id);
    if (record === undefined) return null;
    if (record.lifecycle === 'exited') return record;
    if (record.lifecycle === 'killed' && (record.exitCode !== null || record.exitSignal !== null)) return record;
    const updated: SessionRecord = {
      ...record,
      lifecycle: record.lifecycle === 'killed' ? 'killed' : 'exited',
      endedAtMs: record.endedAtMs ?? Date.now(),
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

  setTitle(id: string, title: string): SessionRecord | null {
    const record = this.sessions.get(id);
    if (record === undefined) return null;
    const updated: SessionRecord = { ...record, title: title.trim().slice(0, 200) };
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

  setOverlay(
    id: string,
    overlay: SessionRecord['overlay'],
    source: SessionRecord['overlaySource']
  ): SessionRecord | null {
    const record = this.sessions.get(id);
    if (record === undefined) return null;
    if (record.lifecycle === 'exited' || record.lifecycle === 'killed') return record;
    if (record.overlay === overlay && record.overlaySource === source) return record;
    const updated: SessionRecord = { ...record, overlay, overlaySource: source };
    this.sessions.set(id, updated);
    this.persist(updated);
    return updated;
  }

  /**
   * Remove a row after the user closes it. Also deletes the per-session
   * folder (metadata, events.jsonl, terminal.log) so closed sessions do
   * not leave terminal bytes on disk. Returns the removed row.
   */
  remove(id: string): SessionRecord | null {
    const record = this.sessions.get(id);
    if (record === undefined) return null;
    this.sessions.delete(id);
    if (this.table !== undefined) {
      try {
        this.table.remove(id);
      } catch {
        // Best effort.
      }
    }
    if (this.dataDir !== undefined) {
      try {
        fs.rmSync(path.join(this.dataDir, 'sessions', id), { recursive: true, force: true });
      } catch {
        // Best effort.
      }
    }
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

  /** True when a live session already owns this pid. Ended rows never block reuse. */
  hasPid(pid: number): boolean {
    for (const record of this.sessions.values()) {
      if (record.pid === pid && isLiveSession(record)) return true;
    }
    return false;
  }

  clear(): void {
    this.sessions.clear();
  }
}
