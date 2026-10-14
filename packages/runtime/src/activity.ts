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
 * Per-task output heartbeat kept by the daemon.
 *
 * Buckets output bytes per second for the last two minutes and keeps a
 * short tail for the last visible line, so any client that connects can
 * draw a full trace immediately instead of starting from flat.
 */
export class ActivityMeter {
  private readonly meters = new Map<string, Meter>();
  /** Bytes per task since the last drain, for the per-second socket tick. */
  private readonly pending = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  record(taskId: string, data: string): void {
    const at = this.now();
    const meter = this.meters.get(taskId) ?? { buckets: new Map<number, number>(), tail: '', lastOutputAtMs: null };
    const second = Math.floor(at / 1000);
    meter.buckets.set(second, (meter.buckets.get(second) ?? 0) + Buffer.byteLength(data, 'utf8'));
    meter.tail = (meter.tail + data).slice(-4096);
    meter.lastOutputAtMs = at;
    this.pending.set(taskId, (this.pending.get(taskId) ?? 0) + Buffer.byteLength(data, 'utf8'));
    const oldest = second - ACTIVITY_WINDOW_SECONDS;
    for (const key of meter.buckets.keys()) {
      if (key > oldest) break;
      meter.buckets.delete(key);
    }
    this.meters.set(taskId, meter);
  }

  forget(taskId: string): void {
    this.meters.delete(taskId);
    this.pending.delete(taskId);
  }

  /**
   * Bytes and last line for every task that produced output since the
   * previous drain, or null when nothing did. One small frame per second
   * replaces streaming every task's bytes to every client.
   */
  drain(): { atMs: number; tasks: Record<string, { bytes: number; lastLine: string | null }> } | null {
    if (this.pending.size === 0) return null;
    const tasks: Record<string, { bytes: number; lastLine: string | null }> = {};
    for (const [taskId, bytes] of this.pending) {
      tasks[taskId] = { bytes, lastLine: lastVisibleLine(this.meters.get(taskId)?.tail ?? '') };
    }
    this.pending.clear();
    return { atMs: this.now(), tasks };
  }

  snapshot(): ActivityResponse {
    const at = this.now();
    const current = Math.floor(at / 1000);
    const tasks: ActivityResponse['tasks'] = {};
    for (const [taskId, meter] of this.meters) {
      const samples: number[] = [];
      for (let second = current - ACTIVITY_WINDOW_SECONDS + 1; second <= current; second++) {
        samples.push(meter.buckets.get(second) ?? 0);
      }
      tasks[taskId] = { samples, lastLine: lastVisibleLine(meter.tail), lastOutputAtMs: meter.lastOutputAtMs };
    }
    return { atMs: at, tasks };
  }
}
