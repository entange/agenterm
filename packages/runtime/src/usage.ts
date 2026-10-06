import type { SessionUsage } from '@agenterm/core';

/** One OTLP attribute value in the JSON encoding. */
interface AnyValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function scalar(value: unknown): string | number | boolean | null {
  const record = asRecord(value) as AnyValue | null;
  if (record === null) return null;
  if (typeof record.doubleValue === 'number') return record.doubleValue;
  if (record.intValue !== undefined) return Number(record.intValue);
  if (typeof record.stringValue === 'string') return record.stringValue;
  if (typeof record.boolValue === 'boolean') return record.boolValue;
  return null;
}

/** One log record flattened to its event name and attributes. */
export interface OtlpEvent {
  name: string;
  attributes: Record<string, string | number | boolean>;
}

/**
 * Flatten an OTLP/HTTP JSON logs payload. Tolerates missing levels and
 * either `event.name` attributes or a string body naming the event.
 */
export function parseOtlpLogs(body: unknown): OtlpEvent[] {
  const out: OtlpEvent[] = [];
  for (const resource of list(asRecord(body)?.['resourceLogs'])) {
    for (const scope of list(asRecord(resource)?.['scopeLogs'])) {
      for (const record of list(asRecord(scope)?.['logRecords'])) {
        const log = asRecord(record);
        if (log === null) continue;
        const attributes: Record<string, string | number | boolean> = {};
        for (const attribute of list(log['attributes'])) {
          const entry = asRecord(attribute);
          const key = entry?.['key'];
          const value = scalar(entry?.['value']);
          if (typeof key === 'string' && value !== null) attributes[key] = value;
        }
        const bodyName = scalar(log['body']);
        const name =
          typeof attributes['event.name'] === 'string'
            ? attributes['event.name']
            : typeof bodyName === 'string'
              ? bodyName
              : '';
        if (name.length > 0) out.push({ name: name.replace(/^claude_code\./, ''), attributes });
      }
    }
  }
  return out;
}

function number(value: string | number | boolean | undefined): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function empty(): SessionUsage {
  return {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    requests: 0,
    errors: 0,
    model: null,
    updatedAtMs: 0
  };
}

/**
 * Running cost and token totals per session, fed by Claude Code's
 * telemetry. Memory only: totals describe the sessions this daemon ran.
 */
export class UsageLedger {
  private readonly totals = new Map<string, SessionUsage>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Apply parsed events; returns true when any total changed. */
  apply(sessionId: string, events: OtlpEvent[]): boolean {
    let changed = false;
    const usage = { ...(this.totals.get(sessionId) ?? empty()) };
    for (const event of events) {
      if (event.name === 'api_request') {
        const a = event.attributes;
        usage.costUsd += number(a['cost_usd']);
        usage.inputTokens += number(a['input_tokens']);
        usage.outputTokens += number(a['output_tokens']);
        usage.cacheReadTokens += number(a['cache_read_tokens']);
        usage.cacheCreationTokens += number(a['cache_creation_tokens']);
        usage.requests += 1;
        if (typeof a['model'] === 'string') usage.model = a['model'];
        changed = true;
      } else if (event.name === 'api_error') {
        usage.errors += 1;
        changed = true;
      }
    }
    if (changed) {
      usage.updatedAtMs = this.now();
      this.totals.set(sessionId, usage);
    }
    return changed;
  }

  get(sessionId: string): SessionUsage | null {
    return this.totals.get(sessionId) ?? null;
  }

  all(): Record<string, SessionUsage> {
    return Object.fromEntries(this.totals);
  }

  forget(sessionId: string): void {
    this.totals.delete(sessionId);
  }
}
