import type {
  RunTaskRequest,
  Settings,
  StopProcessRequest,
  StopTaskRequest,
  TaskInputRequest,
  TaskOutputQuery,
  TaskResizeRequest
} from './api.js';
import { TASK_ID_PATTERN } from './task.js';

/**
 * Validation outcome. Validators never throw for malformed input; they
 * return a code and a message so routes can map them to a 400.
 */
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** POSIX absolute paths plus Windows drive and UNC paths. */
function isAbsolutePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1) return false;
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

const MAX_COMMAND_LENGTH = 32 * 1024;
const MAX_ENV_ENTRIES = 2000;

/** Normalize and check a task id: trimmed, lowercased, safe characters only. */
export function parseTaskId(value: unknown): ValidationResult<string> {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!TASK_ID_PATTERN.test(id)) {
    return {
      ok: false,
      code: 'invalid_id',
      message: 'task id must be 1-64 characters: letters, digits, ".", "_" or "-", starting with a letter or digit'
    };
  }
  return { ok: true, value: id };
}

export function parseRunTaskRequest(body: unknown): ValidationResult<RunTaskRequest> {
  if (!isPlainRecord(body)) return { ok: false, code: 'invalid_body', message: 'body must be an object' };
  const command = body['command'];
  if (typeof command !== 'string' || command.trim().length === 0) {
    return { ok: false, code: 'invalid_command', message: 'command must be a non-empty string' };
  }
  if (command.length > MAX_COMMAND_LENGTH) {
    return { ok: false, code: 'invalid_command', message: 'command must be at most 32KB' };
  }
  const cwd = body['cwd'];
  if (!isAbsolutePath(cwd)) return { ok: false, code: 'invalid_cwd', message: 'cwd must be an absolute path' };
  const out: RunTaskRequest = { command: command.trim(), cwd };
  if (body['id'] !== undefined) {
    const id = parseTaskId(body['id']);
    if (!id.ok) return id;
    out.id = id.value;
  }
  for (const key of ['title', 'startedBy'] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') return { ok: false, code: `invalid_${key}`, message: `${key} must be a string` };
    const trimmed = value.trim().slice(0, 200);
    if (trimmed.length > 0) out[key] = trimmed;
  }
  const startedByPid = body['startedByPid'];
  if (startedByPid !== undefined) {
    if (!isInt(startedByPid, 1, 4_194_304)) {
      return { ok: false, code: 'invalid_startedByPid', message: 'startedByPid must be a pid' };
    }
    out.startedByPid = startedByPid;
  }
  const env = body['env'];
  if (env !== undefined) {
    if (!isPlainRecord(env) || Object.keys(env).length > MAX_ENV_ENTRIES) {
      return { ok: false, code: 'invalid_env', message: 'env must be an object of strings' };
    }
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (typeof value !== 'string' || key.length === 0 || key.includes('=') || key.includes('\0')) {
        return { ok: false, code: 'invalid_env', message: 'env must be an object of strings' };
      }
      clean[key] = value;
    }
    out.env = clean;
  }
  if (body['restart'] !== undefined) {
    if (typeof body['restart'] !== 'boolean') {
      return { ok: false, code: 'invalid_restart', message: 'restart must be a boolean' };
    }
    out.restart = body['restart'];
  }
  if (body['cols'] !== undefined) {
    if (!isInt(body['cols'], 1, 500)) return { ok: false, code: 'invalid_cols', message: 'cols must be 1-500' };
    out.cols = body['cols'];
  }
  if (body['rows'] !== undefined) {
    if (!isInt(body['rows'], 1, 200)) return { ok: false, code: 'invalid_rows', message: 'rows must be 1-200' };
    out.rows = body['rows'];
  }
  return { ok: true, value: out };
}

export function parseStopTaskRequest(body: unknown): ValidationResult<StopTaskRequest> {
  if (body === undefined || body === null) return { ok: true, value: {} };
  if (!isPlainRecord(body)) return { ok: false, code: 'invalid_body', message: 'body must be an object' };
  const force = body['force'];
  if (force !== undefined && typeof force !== 'boolean') {
    return { ok: false, code: 'invalid_force', message: 'force must be a boolean' };
  }
  return { ok: true, value: force === undefined ? {} : { force } };
}

/** A pid from a URL segment or a body. */
export function parsePid(value: unknown): ValidationResult<number> {
  const pid = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!isInt(pid, 2, 4_194_304)) return { ok: false, code: 'invalid_pid', message: 'pid must be a process id' };
  return { ok: true, value: pid };
}

export function parseStopProcessRequest(body: unknown): ValidationResult<StopProcessRequest> {
  if (body === undefined || body === null) return { ok: true, value: {} };
  if (!isPlainRecord(body)) return { ok: false, code: 'invalid_body', message: 'body must be an object' };
  const out: StopProcessRequest = {};
  const force = body['force'];
  if (force !== undefined) {
    if (typeof force !== 'boolean') return { ok: false, code: 'invalid_force', message: 'force must be a boolean' };
    out.force = force;
  }
  const startedAtMs = body['startedAtMs'];
  if (startedAtMs !== undefined) {
    if (!isInt(startedAtMs, 0, Number.MAX_SAFE_INTEGER)) {
      return { ok: false, code: 'invalid_startedAtMs', message: 'startedAtMs must be a timestamp in ms' };
    }
    out.startedAtMs = startedAtMs;
  }
  return { ok: true, value: out };
}

export function parseTaskInputRequest(body: unknown): ValidationResult<TaskInputRequest> {
  if (!isPlainRecord(body)) return { ok: false, code: 'invalid_body', message: 'body must be an object' };
  const data = body['data'];
  if (typeof data !== 'string' || data.length === 0) {
    return { ok: false, code: 'invalid_data', message: 'data must be a non-empty string' };
  }
  if (data.length > 1_048_576) return { ok: false, code: 'invalid_data', message: 'data must be at most 1MB per call' };
  return { ok: true, value: { data } };
}

export function parseTaskResizeRequest(body: unknown): ValidationResult<TaskResizeRequest> {
  if (!isPlainRecord(body)) return { ok: false, code: 'invalid_body', message: 'body must be an object' };
  const cols = body['cols'];
  const rows = body['rows'];
  if (!isInt(cols, 1, 500)) return { ok: false, code: 'invalid_cols', message: 'cols must be an integer 1-500' };
  if (!isInt(rows, 1, 200)) return { ok: false, code: 'invalid_rows', message: 'rows must be an integer 1-200' };
  return { ok: true, value: { cols, rows } };
}

/** Output query with defaults applied. Accepts numbers or numeric strings (from a URL). */
export function parseTaskOutputQuery(
  query: unknown
): ValidationResult<Required<Omit<TaskOutputQuery, 'sinceSeq'>> & { sinceSeq?: number }> {
  if (!isPlainRecord(query)) return { ok: false, code: 'invalid_query', message: 'query must be an object' };
  const num = (value: unknown): unknown =>
    typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Number(value)) ? Number(value) : value;
  const tailBytes = num(query['tailBytes'] ?? 65_536);
  const limit = num(query['limit'] ?? 200);
  const sinceSeq = num(query['sinceSeq']);
  if (!isInt(tailBytes, 1, 1_048_576)) {
    return { ok: false, code: 'invalid_tailBytes', message: 'tailBytes must be an integer 1-1048576' };
  }
  if (!isInt(limit, 1, 1000)) return { ok: false, code: 'invalid_limit', message: 'limit must be an integer 1-1000' };
  if (sinceSeq !== undefined && !isInt(sinceSeq, 0, Number.MAX_SAFE_INTEGER)) {
    return { ok: false, code: 'invalid_sinceSeq', message: 'sinceSeq must be an integer at or above zero' };
  }
  return { ok: true, value: sinceSeq === undefined ? { tailBytes, limit } : { tailBytes, limit, sinceSeq } };
}

export function parseSettingsPatch(body: unknown): ValidationResult<Partial<Settings>> {
  if (!isPlainRecord(body)) return { ok: false, code: 'invalid_body', message: 'body must be an object' };
  const out: Partial<Settings> = {};
  if (body['stopWithAgent'] !== undefined) {
    if (typeof body['stopWithAgent'] !== 'boolean') {
      return { ok: false, code: 'invalid_stopWithAgent', message: 'stopWithAgent must be a boolean' };
    }
    out.stopWithAgent = body['stopWithAgent'];
  }
  return { ok: true, value: out };
}
