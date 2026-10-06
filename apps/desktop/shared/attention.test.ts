import type { SessionRecord } from '@agenterm/core';
import { describe, expect, it } from 'vitest';
import { attentionOf } from './attention.js';

const NOW = 1_000_000;

function row(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    id: 'a',
    agentId: 'claude',
    provider: 'claude',
    title: 't',
    cwd: '/r',
    worktreeRoot: null,
    branch: null,
    origin: 'spawned',
    parentSessionId: null,
    commandLine: ['claude'],
    resolvedBinaryPath: null,
    pid: 10,
    lifecycle: 'running',
    overlay: 'unknown',
    overlaySource: 'pty',
    cols: 80,
    rows: 24,
    startedAtMs: NOW - 600_000,
    endedAtMs: null,
    exitCode: null,
    exitSignal: null,
    ...overrides
  };
}

describe('attentionOf', () => {
  it('puts approval and reply waits first', () => {
    expect(attentionOf(row({ overlay: 'waiting_permission' }), { nowMs: NOW }).group).toBe('needs-you');
    expect(attentionOf(row({ overlay: 'waiting_input' }), { nowMs: NOW }).reason).toBe('Waiting for your reply');
  });

  it('uses recent output to tell working from quiet', () => {
    expect(attentionOf(row({}), { nowMs: NOW, lastOutputAtMs: NOW - 2000 }).group).toBe('working');
    const quiet = attentionOf(row({}), { nowMs: NOW, lastOutputAtMs: NOW - 5 * 60_000 });
    expect(quiet).toEqual({ group: 'quiet', reason: 'Quiet for 5m', signal: 'idle' });
  });

  it('flags bad endings until acknowledged, never clean or user kills', () => {
    const failed = row({ lifecycle: 'exited', exitCode: 2, endedAtMs: NOW });
    expect(attentionOf(failed, { nowMs: NOW }).group).toBe('needs-you');
    expect(attentionOf(failed, { nowMs: NOW, acknowledged: true }).group).toBe('ended');
    expect(attentionOf(row({ lifecycle: 'exited', exitCode: 0 }), { nowMs: NOW }).group).toBe('ended');
    expect(attentionOf(row({ lifecycle: 'killed', exitSignal: 'SIGTERM' }), { nowMs: NOW }).reason).toBe(
      'Killed (SIGTERM)'
    );
    expect(attentionOf(row({ lifecycle: 'crashed' }), { nowMs: NOW }).group).toBe('needs-you');
  });
});
