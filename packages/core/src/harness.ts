import { redactText } from './redaction.js';
import type { SessionOverlayStatus } from './session.js';

/**
 * Harness overlay parsing.
 *
 * Rule: PTY bytes plus process tree are truth. Everything here is a
 * best-effort overlay that may return unknown. Parsing never throws into
 * the event bus. Version mismatch yields unknown with a redacted summary.
 * Flag off means zero file reads outside the agenterm data dir.
 */

export type HarnessProvider = 'claude' | 'codex' | 'opencode' | 'gemini';

/** Supported harness file versions per provider. Pinned for churn guard. */
export const HARNESS_SUPPORTED_VERSIONS: Record<HarnessProvider, readonly string[]> = {
  claude: ['1', '2'],
  codex: ['1'],
  opencode: ['1'],
  gemini: []
};

/** Parse outcome. ok true carries overlay plus redacted summary. */
export type HarnessParseOutcome =
  | { ok: true; overlay: SessionOverlayStatus; summary: string | null; provider: HarnessProvider }
  | { ok: false; overlay: 'unknown'; summary: string | null; provider: HarnessProvider; reason: string };

function toOutcome(
  provider: HarnessProvider,
  overlay: SessionOverlayStatus,
  summary: string | null,
  reason?: string
): HarnessParseOutcome {
  const clean = summary === null ? null : redactText(summary).slice(0, 500);
  if (reason === undefined) {
    return { ok: true, overlay, summary: clean, provider };
  }
  return { ok: false, overlay: 'unknown', summary: clean, provider, reason };
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Parse a Claude harness line.
 *
 * Tolerant: unknown shape yields unknown, never throws. Permission prompts
 * map to waiting_permission. Idleness maps to completed or waiting_input by
 * heuristic. All other text maps to working when a task marker is present,
 * else unknown.
 */
export function parseClaudeHarnessPayload(payload: unknown): HarnessParseOutcome {
  try {
    if (typeof payload !== 'object' || payload === null) {
      return toOutcome('claude', 'unknown', null, 'payload_not_object');
    }
    const record = payload as Record<string, unknown>;
    const version = readText(record['version']);
    if (version !== '' && !HARNESS_SUPPORTED_VERSIONS.claude.includes(version)) {
      return toOutcome('claude', 'unknown', readText(record['summary']), 'unsupported_version');
    }
    const kind = readText(record['kind'] ?? record['type'] ?? record['event']).toLowerCase();
    const text = readText(record['text'] ?? record['message'] ?? record['summary']);
    const blob = `${kind} ${text}`.toLowerCase();
    if (blob.includes('permission') || blob.includes('approve') || blob.includes('allow')) {
      return toOutcome('claude', 'waiting_permission', text);
    }
    if (blob.includes('completed') || blob.includes('done') || blob.includes('finished')) {
      return toOutcome('claude', 'completed', text);
    }
    if (blob.includes('failed') || blob.includes('errored')) {
      return toOutcome('claude', 'failed', text);
    }
    if (blob.includes('waiting') || blob.includes('idle') || blob.includes('input')) {
      return toOutcome('claude', 'waiting_input', text);
    }
    if (blob.includes('working') || blob.includes('running') || blob.includes('tool')) {
      return toOutcome('claude', 'working', text);
    }
    return toOutcome('claude', 'unknown', text.length > 0 ? text : null, 'no_marker');
  } catch {
    return toOutcome('claude', 'unknown', null, 'parse_error');
  }
}

/**
 * Parse a Codex harness payload.
 *
 * Same lenient pattern: read-only shape, unknown on any mismatch, never
 * throws. WAL copies and sqlite reads happen in the runtime layer; this
 * pure function only maps decoded rows to overlay values.
 */
export function parseCodexHarnessPayload(payload: unknown): HarnessParseOutcome {
  try {
    if (typeof payload !== 'object' || payload === null) {
      return toOutcome('codex', 'unknown', null, 'payload_not_object');
    }
    const record = payload as Record<string, unknown>;
    const version = readText(record['version']);
    if (version !== '' && !HARNESS_SUPPORTED_VERSIONS.codex.includes(version)) {
      return toOutcome('codex', 'unknown', readText(record['summary']), 'unsupported_version');
    }
    const status = readText(record['status']).toLowerCase();
    const text = readText(record['summary'] ?? record['text'] ?? record['message']);
    if (status.includes('permission')) return toOutcome('codex', 'waiting_permission', text);
    if (status.includes('complete') || status.includes('done')) return toOutcome('codex', 'completed', text);
    if (status.includes('fail')) return toOutcome('codex', 'failed', text);
    if (status.includes('wait') || status.includes('idle')) return toOutcome('codex', 'waiting_input', text);
    if (status.includes('work') || status.includes('run')) return toOutcome('codex', 'working', text);
    return toOutcome('codex', 'unknown', text.length > 0 ? text : null, 'no_marker');
  } catch {
    return toOutcome('codex', 'unknown', null, 'parse_error');
  }
}

/**
 * Parse an opencode harness payload.
 *
 * Same guards as the other file-backed harnesses. Unknown on mismatch.
 */
export function parseOpencodeHarnessPayload(payload: unknown): HarnessParseOutcome {
  try {
    if (typeof payload !== 'object' || payload === null) {
      return toOutcome('opencode', 'unknown', null, 'payload_not_object');
    }
    const record = payload as Record<string, unknown>;
    const version = readText(record['version']);
    if (version !== '' && !HARNESS_SUPPORTED_VERSIONS.opencode.includes(version)) {
      return toOutcome('opencode', 'unknown', readText(record['summary']), 'unsupported_version');
    }
    const status = readText(record['status'] ?? record['state']).toLowerCase();
    const text = readText(record['summary'] ?? record['text']);
    if (status.includes('permission')) return toOutcome('opencode', 'waiting_permission', text);
    if (status.includes('complete') || status.includes('done')) return toOutcome('opencode', 'completed', text);
    if (status.includes('fail')) return toOutcome('opencode', 'failed', text);
    if (status.includes('wait') || status.includes('idle')) return toOutcome('opencode', 'waiting_input', text);
    if (status.includes('work') || status.includes('run')) return toOutcome('opencode', 'working', text);
    return toOutcome('opencode', 'unknown', text.length > 0 ? text : null, 'no_marker');
  } catch {
    return toOutcome('opencode', 'unknown', null, 'parse_error');
  }
}

/**
 * Parse a Gemini harness payload.
 *
 * Harness log location is unpinned, so this always yields unknown until a
 * real path and schema are confirmed with the user. Never guesses, never
 * writes. Kept as a function so call sites stay uniform.
 */
export function parseGeminiHarnessPayload(_payload: unknown): HarnessParseOutcome {
  return toOutcome('gemini', 'unknown', null, 'location_unpinned');
}

/** Dispatch helper used by the runtime watch loop. Never throws. */
export function parseHarnessPayload(provider: HarnessProvider, payload: unknown): HarnessParseOutcome {
  try {
    if (provider === 'claude') return parseClaudeHarnessPayload(payload);
    if (provider === 'codex') return parseCodexHarnessPayload(payload);
    if (provider === 'opencode') return parseOpencodeHarnessPayload(payload);
    return parseGeminiHarnessPayload(payload);
  } catch {
    return toOutcome(provider, 'unknown', null, 'dispatch_error');
  }
}
