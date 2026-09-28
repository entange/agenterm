import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import mitt, { type Emitter } from 'mitt';
import type { AgentermEvent } from '@agenterm/core';
import { redactText } from '@agenterm/core';

export type BusEventMap = {
  event: AgentermEvent;
};

const MAX_EVENTS = 5000;

/**
 * Daemon-internal event bus with a file mirror.
 *
 * Publishes typed events to in-process subscribers (WebSocket fan-out in
 * the entry layer) and appends each event as one JSON line to
 * sessions/<id>/events.jsonl for tail and debug. Payloads pass through
 * the redactor before either sink. The in-memory list is capped so a
 * runaway session cannot grow the daemon without bound.
 */
export class EventBus {
  private readonly emitter: Emitter<BusEventMap> = mitt<BusEventMap>();
  private readonly recent: AgentermEvent[] = [];
  private readonly dataDir: string | undefined;

  constructor(options: { dataDir?: string | undefined } = {}) {
    this.dataDir = options.dataDir;
  }

  onEvent(handler: (event: AgentermEvent) => void): () => void {
    this.emitter.on('event', handler);
    return () => this.emitter.off('event', handler);
  }

  publish(event: AgentermEvent): AgentermEvent {
    const clean = { ...event, id: event.id.length > 0 ? event.id : crypto.randomUUID() };
    this.recent.push(clean);
    while (this.recent.length > MAX_EVENTS) {
      this.recent.shift();
    }
    if (this.dataDir !== undefined) {
      try {
        const dir = path.join(this.dataDir, 'sessions', clean.sessionId);
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify(clean)}\n`, 'utf8');
      } catch {
        // Mirror is best effort; delivery to subscribers already happened.
      }
    }
    this.emitter.emit('event', clean);
    return clean;
  }

  /** Recent events for one session, oldest first. Used by tests and debug. */
  recentFor(sessionId: string, limit = 100): AgentermEvent[] {
    return this.recent.filter((entry) => entry.sessionId === sessionId).slice(-limit);
  }
}

/** Redact free-text summaries before they enter events or storage. */
export function cleanSummary(value: string | null): string | null {
  if (value === null) return null;
  const out = redactText(value).slice(0, 500);
  return out.length > 0 ? out : null;
}
