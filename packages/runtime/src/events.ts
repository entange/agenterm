import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import mitt, { type Emitter } from 'mitt';
import type { AgentermEvent, EventsQuery } from '@agenterm/core';
import { isLiveOnlyEventKind, redactText } from '@agenterm/core';
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, type SqliteEvents } from './database.js';

export type BusEventMap = {
  event: AgentermEvent;
};

const MAX_EVENTS = 5000;

/** events.jsonl rotates to events.jsonl.1 past this size. */
const MAX_JSONL_BYTES = 5 * 1024 * 1024;

/**
 * Daemon-internal event bus with durable mirrors.
 *
 * Publishes typed events to in-process subscribers (the WebSocket fan-out)
 * and records non-terminal events in SQLite plus a per-session
 * events.jsonl for tail and debug. Terminal bytes are delivered live only:
 * the ring buffer and terminal.log already hold output, and input can
 * carry typed passwords, so neither belongs in an event store. Stored
 * payloads pass through the redactor. The in-memory list is capped so a
 * runaway session cannot grow the daemon without bound.
 */
export class EventBus {
  private readonly emitter: Emitter<BusEventMap> = mitt<BusEventMap>();
  private readonly recent: AgentermEvent[] = [];
  private readonly dataDir: string | undefined;
  private readonly table: SqliteEvents | undefined;

  constructor(options: { dataDir?: string | undefined; table?: SqliteEvents | undefined } = {}) {
    this.dataDir = options.dataDir;
    this.table = options.table;
  }

  onEvent(handler: (event: AgentermEvent) => void): () => void {
    this.emitter.on('event', handler);
    return () => this.emitter.off('event', handler);
  }

  publish(event: AgentermEvent): AgentermEvent {
    const clean = { ...event, id: event.id.length > 0 ? event.id : crypto.randomUUID() };
    if (!isLiveOnlyEventKind(clean.kind)) {
      this.record(clean);
    }
    this.emitter.emit('event', clean);
    return clean;
  }

  private record(event: AgentermEvent): void {
    this.recent.push(event);
    if (this.recent.length > MAX_EVENTS) {
      this.recent.splice(0, this.recent.length - MAX_EVENTS);
    }
    if (this.table !== undefined) {
      try {
        this.table.append(event);
      } catch {
        // SQLite mirror is best effort.
      }
    }
    if (this.dataDir !== undefined) {
      try {
        const dir = path.join(this.dataDir, 'sessions', event.sessionId);
        fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
        const file = path.join(dir, 'events.jsonl');
        rotateIfLarge(file);
        fs.appendFileSync(file, `${redactText(JSON.stringify(event))}\n`, {
          encoding: 'utf8',
          mode: PRIVATE_FILE_MODE
        });
      } catch {
        // Mirror is best effort; delivery to subscribers still happens.
      }
    }
  }

  /** Newest-first history for the activity feed. SQLite when present, else memory. */
  history(query: EventsQuery = {}): AgentermEvent[] {
    const limit = query.limit ?? 100;
    if (this.table !== undefined) {
      try {
        return this.table.recent({ sessionId: query.sessionId, beforeMs: query.beforeMs, limit });
      } catch {
        // Fall through to memory.
      }
    }
    const out: AgentermEvent[] = [];
    for (let i = this.recent.length - 1; i >= 0 && out.length < limit; i--) {
      const event = this.recent[i];
      if (event === undefined) continue;
      if (query.sessionId !== undefined && event.sessionId !== query.sessionId) continue;
      if (query.beforeMs !== undefined && event.createdAtMs >= query.beforeMs) continue;
      out.push(event);
    }
    return out;
  }

  /** Recent events for one session, oldest first. Used by tests and debug. */
  recentFor(sessionId: string, limit = 100): AgentermEvent[] {
    return this.recent.filter((entry) => entry.sessionId === sessionId).slice(-limit);
  }
}

function rotateIfLarge(file: string): void {
  try {
    if (fs.statSync(file).size < MAX_JSONL_BYTES) return;
    fs.renameSync(file, `${file}.1`);
  } catch {
    // Missing file means nothing to rotate.
  }
}

/** Redact free-text summaries before they enter events or storage. */
export function cleanSummary(value: string | null): string | null {
  if (value === null) return null;
  const out = redactText(value).slice(0, 500);
  return out.length > 0 ? out : null;
}
