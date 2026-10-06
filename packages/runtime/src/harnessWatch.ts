import fs from 'node:fs';
import path from 'node:path';
import type { AgentermEvent } from '@agenterm/core';
import { adapterFor } from './adapters/index.js';
import { tailFile } from './adapters/types.js';
import type { EventBus } from './events.js';
import { loadGrants, rootsFor } from './grants.js';
import type { SessionStore } from './sessionStore.js';

export interface AccessLog {
  path: string;
  action: string;
  atMs: number;
}

/**
 * Permission-gated harness watch loop.
 *
 * Best-effort overlay only: PTY bytes plus process tree stay the truth.
 * Behind the enable flag; when off, zero file reads happen outside the
 * agenterm data dir. When on, only roots with an explicit grant are
 * listed or tailed, and every access appends to the audit log.
 * Parse mismatch yields unknown and never throws into the event bus.
 */
export class HarnessWatch {
  private readonly tracked = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private enabled: boolean;
  private readonly dataDir: string | undefined;
  private readonly store: SessionStore;
  private readonly bus: EventBus;
  private readonly intervalMs: number;
  private readonly onAccess: ((entry: AccessLog) => void) | undefined;

  constructor(options: {
    enabled?: boolean | undefined;
    dataDir?: string | undefined;
    store: SessionStore;
    bus: EventBus;
    intervalMs?: number | undefined;
    onAccess?: ((entry: AccessLog) => void) | undefined;
  }) {
    this.enabled = options.enabled ?? false;
    this.dataDir = options.dataDir;
    this.store = options.store;
    this.bus = options.bus;
    this.intervalMs = options.intervalMs ?? 5000;
    this.onAccess = options.onAccess;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  track(sessionId: string): void {
    this.tracked.add(sessionId);
  }

  untrack(sessionId: string): void {
    this.tracked.delete(sessionId);
  }

  private audit(root: string, action: string): void {
    const entry: AccessLog = { path: root, action, atMs: Date.now() };
    if (this.onAccess !== undefined) {
      try {
        this.onAccess(entry);
      } catch {
        // Audit sink is best effort.
      }
      return;
    }
    if (this.dataDir === undefined) return;
    try {
      fs.appendFileSync(path.join(this.dataDir, 'harness-access.log'), `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      // Audit sink is best effort.
    }
  }

  /** Run one watch cycle. Never throws. */
  async poll(): Promise<void> {
    if (!this.enabled || this.dataDir === undefined) return;
    let grants;
    try {
      grants = loadGrants(this.dataDir);
    } catch {
      return;
    }
    if (grants.length === 0) return;
    for (const sessionId of this.tracked) {
      try {
        this.refreshSession(sessionId, grants);
      } catch {
        // One bad session never stops the cycle.
      }
    }
  }

  private refreshSession(sessionId: string, grants: ReturnType<typeof loadGrants>): void {
    const record = this.store.get(sessionId);
    if (record === null) return;
    if (record.lifecycle === 'exited' || record.lifecycle === 'killed') return;
    const adapter = adapterFor(record.provider);
    if (adapter === null) return;
    const roots = rootsFor(grants, adapter.provider);
    if (roots.length === 0) return;
    for (const root of roots) {
      this.audit(root, 'list');
    }
    const files = adapter.discoverFiles(roots, record.cwd).slice(0, 3);
    if (files.length === 0) {
      this.applyOverlay(sessionId, 'unknown', null);
      return;
    }
    for (const file of files.slice(0, 1)) {
      this.audit(file, 'tail');
    }
    const text = tailFile(files[0] ?? '', 65536);
    const outcome = adapter.parseText(text);
    this.applyOverlay(sessionId, outcome.overlay, outcome.summary);
  }

  private applyOverlay(
    sessionId: string,
    overlay: 'unknown' | 'working' | 'waiting_input' | 'waiting_permission' | 'completed' | 'failed',
    summary: string | null
  ): void {
    const record = this.store.get(sessionId);
    if (record === null) return;
    if (record.overlay === overlay) return;
    const updated = this.store.setOverlay(sessionId, overlay, 'harness');
    if (updated === null) return;
    const event: AgentermEvent = {
      id: '',
      sessionId,
      createdAtMs: Date.now(),
      kind: 'agent.status',
      overlay,
      source: 'harness',
      summary
    };
    this.bus.publish(event);
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.poll();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/** Flag check for the watch loop. Off means zero outside reads. */
export function harnessWatchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['AGENTERM_HARNESS_WATCH'] === '1';
}
