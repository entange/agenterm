import { AGENT_PROVIDERS, type AgentProvider } from './agent.js';
import type {
  AttachSessionRequest,
  DeleteSessionRequest,
  ListSessionsQuery,
  SessionInputRequest,
  SessionOutputQuery,
  SessionResizeRequest,
  SessionSignalRequest,
  SpawnSessionRequest,
} from './api.js';
import type { SessionLifecycleStatus, SessionOverlayStatus } from './session.js';

/**
 * Validation outcome.
 *
 * ok true carries the cleaned value. ok false carries a machine readable
 * code plus a redacted human message. Validators never throw for malformed
 * input; they return the failure shape so routes can map to status codes.
 */
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LIFECYCLES: readonly SessionLifecycleStatus[] = [
  'created',
  'starting',
  'running',
  'exited',
  'crashed',
  'killed'
] as const;

const OVERLAYS: readonly SessionOverlayStatus[] = [
  'unknown',
  'working',
  'waiting_input',
  'waiting_permission',
  'completed',
  'failed'
] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && value.length > 1;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isPid(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= 4_194_304
  );
}

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function isDims(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** Check provider key against the known list. */
export function parseAgentProvider(value: unknown): ValidationResult<AgentProvider> {
  if (typeof value !== 'string') {
    return { ok: false, code: 'invalid_provider', message: 'provider must be a string' };
  }
  const found = (AGENT_PROVIDERS as readonly string[]).includes(value);
  if (!found) {
    return { ok: false, code: 'invalid_provider', message: 'provider must be one of claude, codex, gemini, opencode, generic' };
  }
  return { ok: true, value: value as AgentProvider };
}

/** Validate spawn body with defaults applied. */
export function parseSpawnSessionRequest(body: unknown): ValidationResult<SpawnSessionRequest> {
  if (!isPlainRecord(body)) {
    return { ok: false, code: 'invalid_body', message: 'body must be an object' };
  }
  const provider = parseAgentProvider(body['provider']);
  if (!provider.ok) return provider;
  const cwd = body['cwd'];
  if (!isAbsolutePath(cwd)) {
    return { ok: false, code: 'invalid_cwd', message: 'cwd must be an absolute path' };
  }
  const command = body['command'];
  if (command !== undefined && !(typeof command === 'string' && command.trim().length > 0)) {
    return { ok: false, code: 'invalid_command', message: 'command must be a non-empty string when present' };
  }
  const args = body['args'] ?? [];
  if (!Array.isArray(args) || !args.every((entry) => typeof entry === 'string')) {
    return { ok: false, code: 'invalid_args', message: 'args must be a string list' };
  }
  if (args.length > 200) {
    return { ok: false, code: 'invalid_args', message: 'args must hold at most 200 entries' };
  }
  const title = body['title'];
  if (title !== undefined && !(typeof title === 'string' && title.length <= 200)) {
    return { ok: false, code: 'invalid_title', message: 'title must be a string up to 200 chars' };
  }
  const cols = body['cols'] ?? 80;
  const rows = body['rows'] ?? 24;
  if (!isDims(cols, 1, 500)) {
    return { ok: false, code: 'invalid_cols', message: 'cols must be an integer 1-500' };
  }
  if (!isDims(rows, 1, 200)) {
    return { ok: false, code: 'invalid_rows', message: 'rows must be an integer 1-200' };
  }
  const env = body['env'] ?? {};
  if (!isPlainRecord(env)) {
    return { ok: false, code: 'invalid_env', message: 'env must be a string map' };
  }
  for (const [key, entry] of Object.entries(env)) {
    if (typeof entry !== 'string') {
      return { ok: false, code: 'invalid_env', message: 'env values must be strings' };
    }
    if (key.length === 0 || key.length > 256 || entry.length > 32_768) {
      return { ok: false, code: 'invalid_env', message: 'env key or value out of range' };
    }
  }
  const spawnValue: SpawnSessionRequest = {
    provider: provider.value,
    args: args as string[],
    cwd,
    cols,
    rows,
    env: env as Record<string, string>
  };
  if (typeof command === 'string') {
    spawnValue.command = command;
  }
  if (typeof title === 'string') {
    spawnValue.title = title;
  }
  return {
    ok: true,
    value: spawnValue
  };
}

/** Validate attach body. */
export function parseAttachSessionRequest(body: unknown): ValidationResult<AttachSessionRequest> {
  if (!isPlainRecord(body)) {
    return { ok: false, code: 'invalid_body', message: 'body must be an object' };
  }
  const pid = body['pid'];
  if (!isPid(pid)) {
    return { ok: false, code: 'invalid_pid', message: 'pid must be an integer above zero' };
  }
  const title = body['title'];
  if (title !== undefined && !(typeof title === 'string' && title.length <= 200)) {
    return { ok: false, code: 'invalid_title', message: 'title must be a string up to 200 chars' };
  }
  const cwd = body['cwd'] ?? null;
  if (cwd !== null && !isAbsolutePath(cwd)) {
    return { ok: false, code: 'invalid_cwd', message: 'cwd must be an absolute path or null' };
  }
  const attachValue: AttachSessionRequest = { pid };
  if (typeof title === 'string') {
    attachValue.title = title;
  }
  if (typeof cwd === 'string') {
    attachValue.cwd = cwd;
  } else if (cwd === null) {
    attachValue.cwd = null;
  }
  return { ok: true, value: attachValue };
}

/** Validate delete body. */
export function parseDeleteSessionRequest(body: unknown): ValidationResult<DeleteSessionRequest> {
  if (!isPlainRecord(body)) {
    return { ok: false, code: 'invalid_body', message: 'body must be an object' };
  }
  const killTree = body['killTree'];
  if (typeof killTree !== 'boolean') {
    return { ok: false, code: 'invalid_killTree', message: 'killTree must be a boolean' };
  }
  return { ok: true, value: { killTree } };
}

/** Validate input body. */
export function parseSessionInputRequest(body: unknown): ValidationResult<SessionInputRequest> {
  if (!isPlainRecord(body)) {
    return { ok: false, code: 'invalid_body', message: 'body must be an object' };
  }
  const data = body['data'];
  if (typeof data !== 'string' || data.length === 0) {
    return { ok: false, code: 'invalid_data', message: 'data must be a non-empty string' };
  }
  if (data.length > 1_048_576) {
    return { ok: false, code: 'invalid_data', message: 'data must be at most 1MB per call' };
  }
  return { ok: true, value: { data } };
}

/** Validate resize body. */
export function parseSessionResizeRequest(body: unknown): ValidationResult<SessionResizeRequest> {
  if (!isPlainRecord(body)) {
    return { ok: false, code: 'invalid_body', message: 'body must be an object' };
  }
  const cols = body['cols'];
  const rows = body['rows'];
  if (!isDims(cols, 1, 500)) {
    return { ok: false, code: 'invalid_cols', message: 'cols must be an integer 1-500' };
  }
  if (!isDims(rows, 1, 200)) {
    return { ok: false, code: 'invalid_rows', message: 'rows must be an integer 1-200' };
  }
  return { ok: true, value: { cols, rows } };
}

/** Validate signal body. */
export function parseSessionSignalRequest(body: unknown): ValidationResult<SessionSignalRequest> {
  if (!isPlainRecord(body)) {
    return { ok: false, code: 'invalid_body', message: 'body must be an object' };
  }
  const signal = body['signal'];
  if (signal !== 'interrupt' && signal !== 'terminate' && signal !== 'kill') {
    return { ok: false, code: 'invalid_signal', message: 'signal must be interrupt, terminate, or kill' };
  }
  return { ok: true, value: { signal } };
}

/** Validate output query. Applies defaults. */
export function parseSessionOutputQuery(query: unknown): ValidationResult<SessionOutputQuery> {
  if (!isPlainRecord(query)) {
    return { ok: false, code: 'invalid_query', message: 'query must be an object' };
  }
  const tailBytes = query['tailBytes'] ?? 65_536;
  const sinceSeq = query['sinceSeq'];
  const limit = query['limit'] ?? 200;
  if (!isDims(tailBytes, 1, 1_048_576)) {
    return { ok: false, code: 'invalid_tailBytes', message: 'tailBytes must be an integer 1-1048576' };
  }
  if (sinceSeq !== undefined && !(typeof sinceSeq === 'number' && Number.isInteger(sinceSeq) && sinceSeq >= 0)) {
    return { ok: false, code: 'invalid_sinceSeq', message: 'sinceSeq must be an integer at or above zero' };
  }
  if (!isDims(limit, 1, 1000)) {
    return { ok: false, code: 'invalid_limit', message: 'limit must be an integer 1-1000' };
  }
  const outputValue: SessionOutputQuery = {
    tailBytes,
    limit
  };
  if (typeof sinceSeq === 'number') {
    outputValue.sinceSeq = sinceSeq;
  }
  return {
    ok: true,
    value: outputValue
  };
}

/** Validate list filters. All fields optional. */
export function parseListSessionsQuery(query: unknown): ValidationResult<ListSessionsQuery> {
  if (!isPlainRecord(query)) {
    return { ok: false, code: 'invalid_query', message: 'query must be an object' };
  }
  const out: ListSessionsQuery = {};
  if (query['provider'] !== undefined) {
    const parsed = parseAgentProvider(query['provider']);
    if (!parsed.ok) return parsed;
    out.provider = parsed.value;
  }
  if (query['lifecycle'] !== undefined) {
    const raw = query['lifecycle'];
    if (typeof raw !== 'string' || !(LIFECYCLES as readonly string[]).includes(raw)) {
      return { ok: false, code: 'invalid_lifecycle', message: 'lifecycle filter is not recognized' };
    }
    out.lifecycle = raw as SessionLifecycleStatus;
  }
  if (query['overlay'] !== undefined) {
    const raw = query['overlay'];
    if (typeof raw !== 'string' || !(OVERLAYS as readonly string[]).includes(raw)) {
      return { ok: false, code: 'invalid_overlay', message: 'overlay filter is not recognized' };
    }
    out.overlay = raw as SessionOverlayStatus;
  }
  if (query['cwd'] !== undefined) {
    const raw = query['cwd'];
    if (!isAbsolutePath(raw)) {
      return { ok: false, code: 'invalid_cwd', message: 'cwd filter must be an absolute path' };
    }
    out.cwd = raw;
  }
  return { ok: true, value: out };
}

/** Validate session id path param. */
export function parseSessionIdParam(value: unknown): ValidationResult<string> {
  if (!isUuid(value)) {
    return { ok: false, code: 'invalid_session_id', message: 'session id must be a UUID string' };
  }
  return { ok: true, value };
}

/** Validate pid path or body value. Shared helper. */
export function parsePidValue(value: unknown): ValidationResult<number> {
  if (!isPid(value)) {
    return { ok: false, code: 'invalid_pid', message: 'pid must be an integer above zero' };
  }
  return { ok: true, value };
}

/** Validate port value. Shared helper. */
export function parsePortValue(value: unknown): ValidationResult<number> {
  if (!isPort(value)) {
    return { ok: false, code: 'invalid_port', message: 'port must be an integer 1-65535' };
  }
  return { ok: true, value };
}

/** Check a non-empty string helper used by title and command checks. */
export function parseNonEmptyString(value: unknown, code: string): ValidationResult<string> {
  if (!isNonEmptyString(value)) {
    return { ok: false, code, message: 'value must be a non-empty string' };
  }
  return { ok: true, value: value.trim() };
}
