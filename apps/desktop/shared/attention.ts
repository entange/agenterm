import type { SessionRecord } from '@agenterm/core';

/** Board groups, in display order. */
export type AttentionGroup = 'needs-you' | 'working' | 'quiet' | 'ended';

export const ATTENTION_ORDER: readonly AttentionGroup[] = ['needs-you', 'working', 'quiet', 'ended'];

/** Signal color names, matching the UI palette. */
export type AttentionSignal = 'attn' | 'work' | 'fail' | 'ok' | 'idle';

export interface Attention {
  group: AttentionGroup;
  /** Short reason in user terms, shown on the strip. */
  reason: string;
  /** Color meaning: attn waits on the user, fail went wrong, work is busy. */
  signal: AttentionSignal;
}

/** Output within this window counts as working. */
export const WORKING_WINDOW_MS = 15_000;

function quietFor(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'Quiet for a moment';
  if (minutes < 60) return `Quiet for ${minutes}m`;
  return `Quiet for ${Math.floor(minutes / 60)}h`;
}

/**
 * Classify a session for the board.
 *
 * Needs you: the harness says it is waiting on approval or a reply, it
 * reported a failure, or it ended badly and nobody has looked yet.
 * Working: output in the last few seconds or the harness says working.
 * Quiet: alive with no recent output. Ended: finished and acknowledged,
 * or finished cleanly.
 */
export function attentionOf(
  session: SessionRecord,
  context: { nowMs: number; lastOutputAtMs?: number | undefined; acknowledged?: boolean | undefined }
): Attention {
  const live = session.lifecycle === 'running' || session.lifecycle === 'starting' || session.lifecycle === 'created';
  if (live) {
    if (session.overlay === 'waiting_permission')
      return { group: 'needs-you', reason: 'Waiting for your approval', signal: 'attn' };
    if (session.overlay === 'waiting_input')
      return { group: 'needs-you', reason: 'Waiting for your reply', signal: 'attn' };
    if (session.overlay === 'failed') return { group: 'needs-you', reason: 'Reported a failure', signal: 'fail' };
    if (session.origin === 'attached') {
      return session.overlay === 'working'
        ? { group: 'working', reason: 'Working (attached)', signal: 'work' }
        : { group: 'quiet', reason: `Watching pid ${session.pid}`, signal: 'idle' };
    }
    const since =
      context.lastOutputAtMs === undefined ? Number.POSITIVE_INFINITY : context.nowMs - context.lastOutputAtMs;
    if (session.overlay === 'working' || since <= WORKING_WINDOW_MS)
      return { group: 'working', reason: 'Working', signal: 'work' };
    if (session.overlay === 'completed') return { group: 'quiet', reason: 'Finished its task', signal: 'ok' };
    const quietMs = Number.isFinite(since) ? since : context.nowMs - session.startedAtMs;
    return { group: 'quiet', reason: quietFor(quietMs), signal: 'idle' };
  }
  const acknowledged = context.acknowledged === true;
  if (session.lifecycle === 'crashed') {
    return { group: acknowledged ? 'ended' : 'needs-you', reason: 'Lost when the daemon stopped', signal: 'fail' };
  }
  if (session.lifecycle === 'killed') {
    return {
      group: 'ended',
      reason: `Killed${session.exitSignal === null ? '' : ` (${session.exitSignal})`}`,
      signal: 'idle'
    };
  }
  if (session.exitSignal !== null) {
    return { group: acknowledged ? 'ended' : 'needs-you', reason: `Ended by ${session.exitSignal}`, signal: 'fail' };
  }
  if (session.exitCode !== null && session.exitCode !== 0) {
    return {
      group: acknowledged ? 'ended' : 'needs-you',
      reason: `Exited with code ${session.exitCode}`,
      signal: 'fail'
    };
  }
  return { group: 'ended', reason: 'Finished', signal: 'ok' };
}

/** Stable key for "has the user seen how this ended". Changes if it ends again. */
export function acknowledgementKey(session: SessionRecord): string {
  return `${session.id}:${session.endedAtMs ?? 'live'}`;
}
