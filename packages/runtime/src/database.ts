import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { TaskRecord, TaskStatus } from '@agenterm/core';

/** Owner-only modes for the data dir and every file holding task data. */
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

function chmodQuiet(file: string, mode: number): void {
  try {
    fs.chmodSync(file, mode);
  } catch {
    // Missing sidecar files and non-POSIX filesystems are fine.
  }
}

/** Tables from the session-based builds. Dropped on first open. */
const OLD_TABLES = ['sessions', 'events', 'commands', 'processes', 'agents', 'workspaces', 'projects', 'machines'];

const DDL = `CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  project TEXT,
  project_root TEXT,
  branch TEXT,
  started_by TEXT,
  started_by_pid INTEGER,
  pid INTEGER NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER,
  exit_signal TEXT,
  cols INTEGER NOT NULL,
  rows INTEGER NOT NULL,
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER
)`;

/**
 * Open the embedded database, creating the file and schema on demand.
 * The database and its WAL sidecars are owner-only because rows carry
 * command lines and folders.
 */
export function openDatabase(file: string): Database.Database {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: PRIVATE_DIR_MODE });
  const raw = new Database(file);
  raw.pragma('busy_timeout = 5000');
  raw.pragma('journal_mode = WAL');
  raw.pragma('synchronous = NORMAL');
  for (const table of OLD_TABLES) raw.exec(`DROP TABLE IF EXISTS ${table}`);
  raw.exec(DDL);
  for (const sidecar of ['', '-wal', '-shm']) {
    chmodQuiet(`${file}${sidecar}`, PRIVATE_FILE_MODE);
  }
  return raw;
}

/** Default database path inside the data dir. */
export function databaseFile(dataDir: string): string {
  return path.join(dataDir, 'agenterm.db');
}

interface TaskRow {
  id: string;
  title: string;
  command: string;
  cwd: string;
  project: string | null;
  project_root: string | null;
  branch: string | null;
  started_by: string | null;
  started_by_pid: number | null;
  pid: number;
  status: string;
  exit_code: number | null;
  exit_signal: string | null;
  cols: number;
  rows: number;
  started_at_ms: number;
  ended_at_ms: number | null;
}

const STATUSES: readonly TaskStatus[] = ['running', 'exited', 'failed', 'stopped', 'lost'];

function rowToTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    title: row.title,
    command: row.command,
    cwd: row.cwd,
    project: row.project,
    projectRoot: row.project_root,
    branch: row.branch,
    startedBy: row.started_by,
    startedByPid: row.started_by_pid,
    pid: row.pid,
    status: STATUSES.includes(row.status as TaskStatus) ? (row.status as TaskStatus) : 'lost',
    exitCode: row.exit_code,
    exitSignal: row.exit_signal,
    ports: [],
    cols: row.cols,
    rows: row.rows,
    startedAtMs: row.started_at_ms,
    endedAtMs: row.ended_at_ms
  };
}

/**
 * Task rows. Ports are live state and are not stored. Writes are
 * synchronous; a row is a few hundred bytes and changes only on start,
 * resize and exit.
 */
export class TaskTable {
  private readonly upsertStatement: Database.Statement;
  private readonly getStatement: Database.Statement;
  private readonly listStatement: Database.Statement;
  private readonly deleteStatement: Database.Statement;

  constructor(private readonly raw: Database.Database) {
    this.upsertStatement = raw.prepare(`INSERT INTO tasks (
      id, title, command, cwd, project, project_root, branch, started_by, started_by_pid, pid, status,
      exit_code, exit_signal, cols, rows, started_at_ms, ended_at_ms
    ) VALUES (
      @id, @title, @command, @cwd, @project, @project_root, @branch, @started_by, @started_by_pid, @pid, @status,
      @exit_code, @exit_signal, @cols, @rows, @started_at_ms, @ended_at_ms
    ) ON CONFLICT(id) DO UPDATE SET
      title = excluded.title, command = excluded.command, cwd = excluded.cwd, project = excluded.project,
      project_root = excluded.project_root, branch = excluded.branch, started_by = excluded.started_by,
      started_by_pid = excluded.started_by_pid, pid = excluded.pid, status = excluded.status,
      exit_code = excluded.exit_code, exit_signal = excluded.exit_signal, cols = excluded.cols,
      rows = excluded.rows, started_at_ms = excluded.started_at_ms, ended_at_ms = excluded.ended_at_ms`);
    this.getStatement = raw.prepare('SELECT * FROM tasks WHERE id = ?');
    this.listStatement = raw.prepare('SELECT * FROM tasks ORDER BY started_at_ms DESC');
    this.deleteStatement = raw.prepare('DELETE FROM tasks WHERE id = ?');
  }

  put(task: TaskRecord): void {
    this.upsertStatement.run({
      id: task.id,
      title: task.title,
      command: task.command,
      cwd: task.cwd,
      project: task.project,
      project_root: task.projectRoot,
      branch: task.branch,
      started_by: task.startedBy,
      started_by_pid: task.startedByPid,
      pid: task.pid,
      status: task.status,
      exit_code: task.exitCode,
      exit_signal: task.exitSignal,
      cols: task.cols,
      rows: task.rows,
      started_at_ms: task.startedAtMs,
      ended_at_ms: task.endedAtMs
    });
  }

  get(id: string): TaskRecord | null {
    const row = this.getStatement.get(id) as TaskRow | undefined;
    return row === undefined ? null : rowToTask(row);
  }

  /** Newest first. */
  list(): TaskRecord[] {
    return (this.listStatement.all() as TaskRow[]).map(rowToTask);
  }

  delete(id: string): void {
    this.deleteStatement.run(id);
  }

  /**
   * Mark rows left running by a previous daemon as lost. Their terminals
   * died with it. Returns the ids changed.
   */
  markLost(nowMs: number): string[] {
    const ids = (this.raw.prepare("SELECT id FROM tasks WHERE status = 'running'").all() as Array<{ id: string }>).map(
      (row) => row.id
    );
    this.raw.prepare("UPDATE tasks SET status = 'lost', ended_at_ms = ? WHERE status = 'running'").run(nowMs);
    return ids;
  }
}
