import { lastVisibleLine, type ActivityResponse } from '@agenterm/core';

/** Heartbeat window in one-second buckets. */
export const ACTIVITY_WINDOW_SECONDS = 120;

interface Meter {
  /** Bytes per absolute second, keyed by floor(ms / 1000). */
  buckets: Map<number, number>;
  tail: string;
  lastOutputAtMs: number | null;
}

/**
 * Per-session output heartbeat kept by the daemon.
 *
 * Buckets output bytes per second for the last two minutes and keeps a
 * short tail for the last visible line, so any client that connects can
 * draw a full trace immediately instead of starting from flat.
 */
export class ActivityMeter {
  private readonly meters = new Map<string, Meter>();
  /** Bytes per session since the last drain, for the per-second socket tick. */
  private readonly pending = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  record(sessionId: string, data: string): void {
    const at = this.now();
    const meter = this.meters.get(sessionId) ?? { buckets: new Map<number, number>(), tail: '', lastOutputAtMs: null };
    const second = Math.floor(at / 1000);
    meter.buckets.set(second, (meter.buckets.get(second) ?? 0) + Buffer.byteLength(data, 'utf8'));
    meter.tail = (meter.tail + data).slice(-4096);
    meter.lastOutputAtMs = at;
    this.pending.set(sessionId, (this.pending.get(sessionId) ?? 0) + Buffer.byteLength(data, 'utf8'));
    const oldest = second - ACTIVITY_WINDOW_SECONDS;
    for (const key of meter.buckets.keys()) {
      if (key > oldest) break;
      meter.buckets.delete(key);
    }
    this.meters.set(sessionId, meter);
  }

  forget(sessionId: string): void {
    this.meters.delete(sessionId);
    this.pending.delete(sessionId);
  }

  /**
   * Bytes and last line for every session that produced output since the
   * previous drain, or null when nothing did. One small frame per second
   * replaces streaming every session's bytes to every client.
   */
  drain(): { atMs: number; sessions: Record<string, { bytes: number; lastLine: string | null }> } | null {
    if (this.pending.size === 0) return null;
    const sessions: Record<string, { bytes: number; lastLine: string | null }> = {};
    for (const [sessionId, bytes] of this.pending) {
      sessions[sessionId] = { bytes, lastLine: lastVisibleLine(this.meters.get(sessionId)?.tail ?? '') };
    }
    this.pending.clear();
    return { atMs: this.now(), sessions };
  }

  snapshot(): ActivityResponse {
    const at = this.now();
    const current = Math.floor(at / 1000);
    const sessions: ActivityResponse['sessions'] = {};
    for (const [sessionId, meter] of this.meters) {
      const samples: number[] = [];
      for (let second = current - ACTIVITY_WINDOW_SECONDS + 1; second <= current; second++) {
        samples.push(meter.buckets.get(second) ?? 0);
      }
      sessions[sessionId] = { samples, lastLine: lastVisibleLine(meter.tail), lastOutputAtMs: meter.lastOutputAtMs };
    }
    return { atMs: at, sessions };
  }
}
