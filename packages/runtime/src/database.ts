import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { and, asc, desc, eq, lt, sql } from 'drizzle-orm';
import type { AgentermEvent, CommandRecord, EventRow, SessionRecord } from '@agenterm/core';
import { redactText } from '@agenterm/core';
import * as schema from './schema.js';

export type RuntimeDatabase = BetterSQLite3Database<typeof schema>;

/** Cap for the events table. Older rows prune first. */
export const EVENTS_CAP = 20000;

/** Default retention for events and commands, per docs/07. */
export const RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Owner-only modes for the data dir and every file holding session data. */
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

function chmodQuiet(file: string, mode: number): void {
  try {
    fs.chmodSync(file, mode);
  } catch {
    // Missing sidecar files and non-POSIX filesystems are fine.
  }
}

const DDL = [
  `CREATE TABLE IF NOT EXISTS machines (
    id TEXT PRIMARY KEY,
    hostname TEXT NOT NULL,
    platform TEXT NOT NULL,
    arch TEXT NOT NULL,
    first_seen_at_ms INTEGER NOT NULL,
    last_seen_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    machine_id TEXT NOT NULL,
    name TEXT NOT NULL,
    root_path TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS projects_machine_idx ON projects (machine_id)`,
  `CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    cwd TEXT NOT NULL,
    worktree_root TEXT,
    branch TEXT,
    is_dirty INTEGER,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS workspaces_project_idx ON workspaces (project_id)`,
  `CREATE INDEX IF NOT EXISTS workspaces_cwd_idx ON workspaces (cwd)`,
  `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    display_name TEXT NOT NULL,
    command TEXT NOT NULL,
    args_json TEXT NOT NULL,
    env_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS agents_workspace_idx ON agents (workspace_id)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    title TEXT NOT NULL,
    cwd TEXT NOT NULL,
    worktree_root TEXT,
    branch TEXT,
    origin TEXT NOT NULL,
    parent_session_id TEXT,
    command_line_json TEXT NOT NULL,
    resolved_binary_path TEXT,
    pid INTEGER NOT NULL,
    lifecycle TEXT NOT NULL,
    overlay TEXT NOT NULL,
    overlay_source TEXT NOT NULL,
    cols INTEGER NOT NULL,
    rows INTEGER NOT NULL,
    started_at_ms INTEGER NOT NULL,
    ended_at_ms INTEGER,
    exit_code INTEGER,
    exit_signal TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS sessions_started_idx ON sessions (started_at_ms)`,
  `CREATE INDEX IF NOT EXISTS sessions_lifecycle_idx ON sessions (lifecycle)`,
  `CREATE INDEX IF NOT EXISTS sessions_cwd_idx ON sessions (cwd)`,
  `CREATE TABLE IF NOT EXISTS processes (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    pid INTEGER NOT NULL,
    ppid INTEGER NOT NULL,
    command TEXT NOT NULL,
    cwd TEXT,
    cpu_percent INTEGER,
    rss_bytes INTEGER,
    started_at_ms INTEGER,
    ended_at_ms INTEGER,
    exit_code INTEGER,
    sampled_at_ms INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS processes_session_idx ON processes (session_id)`,
  `CREATE INDEX IF NOT EXISTS processes_sampled_idx ON processes (sampled_at_ms)`,
  `CREATE TABLE IF NOT EXISTS commands (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    text TEXT NOT NULL,
    cwd TEXT NOT NULL,
    pid INTEGER,
    started_at_ms INTEGER NOT NULL,
    duration_ms INTEGER,
    exit_code INTEGER,
    output_line_count INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS commands_session_idx ON commands (session_id)`,
  `CREATE INDEX IF NOT EXISTS commands_started_idx ON commands (started_at_ms)`,
  `CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS events_session_idx ON events (session_id)`,
  `CREATE INDEX IF NOT EXISTS events_time_idx ON events (created_at_ms)`
];

/**
 * Open the embedded database, creating the file and schema on demand.
 *
 * WAL with synchronous=NORMAL keeps each event insert off the fsync path
 * while staying crash-safe for committed rows. The database and its WAL
 * sidecars are owner-only because events carry command lines and cwds.
 */
export function openDatabase(file: string): { raw: Database.Database; db: RuntimeDatabase } {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: PRIVATE_DIR_MODE });
  const raw = new Database(file);
  raw.pragma('busy_timeout = 5000');
  raw.pragma('journal_mode = WAL');
  raw.pragma('synchronous = NORMAL');
  for (const statement of DDL) {
    raw.exec(statement);
  }
  migrate(raw);
  for (const sidecar of ['', '-wal', '-shm']) {
    chmodQuiet(`${file}${sidecar}`, PRIVATE_FILE_MODE);
  }
  const db = drizzle(raw, { schema });
  return { raw, db };
}

/** Additive column migrations for databases created by earlier builds. */
function migrate(raw: Database.Database): void {
  const columns = new Set((raw.pragma('table_info(sessions)') as Array<{ name: string }>).map((column) => column.name));
  if (!columns.has('parent_session_id')) raw.exec('ALTER TABLE sessions ADD COLUMN parent_session_id TEXT');
}

/** Default database path inside the data dir. */
export function databaseFile(dataDir: string): string {
  return path.join(dataDir, 'agenterm.db');
}

function parseCommandLine(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')) {
      return parsed as string[];
    }
    return [];
  } catch {
    return [];
  }
}

export function sessionToRow(record: SessionRecord): typeof schema.sessions.$inferInsert {
  return {
    id: record.id,
    agentId: record.agentId,
    provider: record.provider,
    title: record.title,
    cwd: record.cwd,
    worktreeRoot: record.worktreeRoot,
    branch: record.branch,
    origin: record.origin,
    parentSessionId: record.parentSessionId,
    commandLineJson: JSON.stringify(record.commandLine),
    resolvedBinaryPath: record.resolvedBinaryPath,
    pid: record.pid,
    lifecycle: record.lifecycle,
    overlay: record.overlay,
    overlaySource: record.overlaySource,
    cols: record.cols,
    rows: record.rows,
    startedAtMs: record.startedAtMs,
    endedAtMs: record.endedAtMs,
    exitCode: record.exitCode,
    exitSignal: record.exitSignal
  };
}

export interface SessionRowShape {
  id: string;
  agentId: string;
  provider: string;
  title: string;
  cwd: string;
  worktreeRoot?: string | null | undefined;
  branch?: string | null | undefined;
  origin: string;
  parentSessionId?: string | null | undefined;
  commandLineJson: string;
  resolvedBinaryPath?: string | null | undefined;
  pid: number;
  lifecycle: string;
  overlay: string;
  overlaySource: string;
  cols: number;
  rows: number;
  startedAtMs: number;
  endedAtMs?: number | null | undefined;
  exitCode?: number | null | undefined;
  exitSignal?: string | null | undefined;
}

export function rowToSession(row: SessionRowShape): SessionRecord {
  return {
    id: row.id,
    agentId: row.agentId,
    provider: row.provider as SessionRecord['provider'],
    title: row.title,
    cwd: row.cwd,
    worktreeRoot: row.worktreeRoot ?? null,
    branch: row.branch ?? null,
    origin: row.origin as SessionRecord['origin'],
    parentSessionId: row.parentSessionId ?? null,
    commandLine: parseCommandLine(row.commandLineJson),
    resolvedBinaryPath: row.resolvedBinaryPath ?? null,
    pid: row.pid,
    lifecycle: row.lifecycle as SessionRecord['lifecycle'],
    overlay: row.overlay as SessionRecord['overlay'],
    overlaySource: row.overlaySource as SessionRecord['overlaySource'],
    cols: row.cols,
    rows: row.rows,
    startedAtMs: row.startedAtMs,
    endedAtMs: row.endedAtMs ?? null,
    exitCode: row.exitCode ?? null,
    exitSignal: row.exitSignal ?? null
  };
}

/** Write-through session table. Memory stays authoritative in the store. */
export class SqliteSessions {
  constructor(private readonly db: RuntimeDatabase) {}

  save(record: SessionRecord): void {
    const row = sessionToRow(record);
    this.db.insert(schema.sessions).values(row).onConflictDoUpdate({ target: schema.sessions.id, set: row }).run();
  }

  get(id: string): SessionRecord | null {
    const rows = this.db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).limit(1).all();
    const row = rows[0];
    return row === undefined ? null : rowToSession(row);
  }

  all(): SessionRecord[] {
    return this.db.select().from(schema.sessions).orderBy(desc(schema.sessions.startedAtMs)).all().map(rowToSession);
  }

  remove(id: string): void {
    this.db.delete(schema.sessions).where(eq(schema.sessions.id, id)).run();
  }

  /** Mark rows left live by a previous daemon run as crashed. Returns the count. */
  replayCrashes(now = Date.now()): number {
    const live = this.db
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(sql`${schema.sessions.lifecycle} IN ('created', 'starting', 'running')`)
      .all();
    for (const row of live) {
      this.db
        .update(schema.sessions)
        .set({ lifecycle: 'crashed', endedAtMs: now })
        .where(eq(schema.sessions.id, row.id))
        .run();
    }
    return live.length;
  }
}

/** Append-only event table with a cap and per-session reads. */
export class SqliteEvents {
  constructor(private readonly db: RuntimeDatabase) {}

  append(event: AgentermEvent): EventRow {
    const row: EventRow = {
      id: event.id.length > 0 ? event.id : crypto.randomUUID(),
      sessionId: event.sessionId,
      kind: event.kind,
      payloadJson: redactText(JSON.stringify(event)),
      createdAtMs: event.createdAtMs
    };
    this.db.insert(schema.events).values(row).onConflictDoNothing().run();
    return row;
  }

  forSession(sessionId: string, limit = 200): EventRow[] {
    return this.db
      .select()
      .from(schema.events)
      .where(eq(schema.events.sessionId, sessionId))
      .orderBy(asc(schema.events.createdAtMs))
      .limit(limit)
      .all()
      .map((row) => ({ ...row, kind: row.kind as EventRow['kind'] }));
  }

  /** Newest-first page across sessions for the activity feed. */
  recent(
    query: { sessionId?: string | undefined; beforeMs?: number | undefined; limit?: number | undefined } = {}
  ): AgentermEvent[] {
    const filters = [];
    if (query.sessionId !== undefined) filters.push(eq(schema.events.sessionId, query.sessionId));
    if (query.beforeMs !== undefined) filters.push(lt(schema.events.createdAtMs, query.beforeMs));
    const rows = this.db
      .select()
      .from(schema.events)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(schema.events.createdAtMs))
      .limit(query.limit ?? 100)
      .all();
    const out: AgentermEvent[] = [];
    for (const row of rows) {
      try {
        out.push(JSON.parse(row.payloadJson) as AgentermEvent);
      } catch {
        // Skip rows a past version wrote in another shape.
      }
    }
    return out;
  }

  /** Drop rows past the cap or older than the retention window. Returns the removed count. */
  prune(cap = EVENTS_CAP, retentionDays = RETENTION_DAYS, now = Date.now()): number {
    return pruneTable(this.db, 'events', 'created_at_ms', cap, now - retentionDays * DAY_MS);
  }
}

function pruneTable(
  db: RuntimeDatabase,
  table: 'events' | 'commands',
  timeColumn: string,
  cap: number,
  cutoffMs: number
): number {
  const byAge = db.run(sql.raw(`DELETE FROM ${table} WHERE ${timeColumn} < ${Math.floor(cutoffMs)}`));
  const byCap = db.run(
    sql.raw(
      `DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} ORDER BY ${timeColumn} DESC LIMIT -1 OFFSET ${Math.max(0, Math.floor(cap))})`
    )
  );
  return byAge.changes + byCap.changes;
}

/** Cap for the commands table. Oldest rows prune first. */
export const COMMANDS_CAP = 10000;

/** Upsert command rows keyed by id. Newest start time first on read. */
export class SqliteCommands {
  constructor(private readonly db: RuntimeDatabase) {}

  save(record: CommandRecord): void {
    const row = {
      id: record.id,
      sessionId: record.sessionId,
      text: record.text,
      cwd: record.cwd,
      pid: record.pid,
      startedAtMs: record.startedAtMs,
      durationMs: record.durationMs,
      exitCode: record.exitCode,
      outputLineCount: record.outputLineCount
    };
    this.db.insert(schema.commands).values(row).onConflictDoUpdate({ target: schema.commands.id, set: row }).run();
  }

  forSession(sessionId: string, limit = 100): CommandRecord[] {
    return this.db
      .select()
      .from(schema.commands)
      .where(eq(schema.commands.sessionId, sessionId))
      .orderBy(desc(schema.commands.startedAtMs))
      .limit(limit)
      .all()
      .map((row) => ({
        id: row.id,
        sessionId: row.sessionId,
        text: row.text,
        cwd: row.cwd,
        pid: row.pid,
        startedAtMs: row.startedAtMs,
        durationMs: row.durationMs,
        exitCode: row.exitCode,
        outputLineCount: row.outputLineCount
      }));
  }

  /** Drop rows past the cap or older than the retention window. Returns the removed count. */
  prune(cap = COMMANDS_CAP, retentionDays = RETENTION_DAYS, now = Date.now()): number {
    return pruneTable(this.db, 'commands', 'started_at_ms', cap, now - retentionDays * DAY_MS);
  }
}
