import { describe, expect, it } from 'vitest';
import type { CommandRecord } from '@agenterm/core';
import { CommandTracker } from '../src/commands.js';

function feedAll(tracker: CommandTracker, chunks: string[]): void {
  for (const chunk of chunks) tracker.feed(chunk);
}

describe('CommandTracker', () => {
  it('opens a command at a prompt and closes at the following one', () => {
    let now = 1000;
    const tracker = new CommandTracker({ sessionId: 's1', cwd: '/tmp', now: () => now });
    feedAll(tracker, ['sh-3.2$ bun test\n', 'ok 12 pass\n', 'sh-3.2$ ']);
    now = 1500;
    feedAll(tracker, ['echo done\n']);
    const rows = tracker.rows();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.text).toBe('bun test');
    expect(rows[0]?.durationMs).toBe(500);
    expect(rows[0]?.outputLineCount).toBe(1);
    expect(rows[0]?.exitCode).toBe(null);
    expect(rows[1]?.text).toBe('echo done');
    expect(rows[1]?.durationMs).toBe(null);
  });

  it('handles split chunks and colored prompts', () => {
    const tracker = new CommandTracker({ sessionId: 's1', cwd: '/tmp' });
    feedAll(tracker, ['\x1b[32mwork$\x1b[0m ', 'git sta', 'tus\n']);
    const rows = tracker.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe('git status');
  });

  it('ignores noise without prompts', () => {
    const tracker = new CommandTracker({ sessionId: 's1', cwd: '/tmp' });
    feedAll(tracker, ['downloading…\n', 'still going\n']);
    expect(tracker.rows()).toHaveLength(0);
  });

  it('closes open commands at session end', () => {
    let now = 1000;
    const saved: CommandRecord[] = [];
    const tracker = new CommandTracker({
      sessionId: 's1',
      cwd: '/tmp',
      pid: 9,
      now: () => now,
      save: (record) => saved.push(record)
    });
    feedAll(tracker, ['$ sleep 30\n']);
    now = 4000;
    tracker.closeAll();
    const rows = tracker.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.durationMs).toBe(3000);
    expect(rows[0]?.pid).toBe(9);
    expect(saved[saved.length - 1]?.durationMs).toBe(3000);
  });

  it('never throws on odd bytes', () => {
    const tracker = new CommandTracker({ sessionId: 's1', cwd: '/tmp' });
    expect(() => feedAll(tracker, ['\x00\xff\n', '$ \n', '\x1b[999;888H$\n'])).not.toThrow();
  });
});

describe('CommandTracker bounds', () => {
  it('caps buffered bytes for output without newlines', async () => {
    const { CommandTracker } = await import('../src/commands.js');
    const tracker = new CommandTracker({ sessionId: 's', cwd: '/tmp' });
    for (let i = 0; i < 200; i++) tracker.feed('x'.repeat(4096));
    expect((tracker as unknown as { pending: string }).pending.length).toBeLessThanOrEqual(64 * 1024);
  });

  it('redacts secrets in command text and handles long lines quickly', async () => {
    const { CommandTracker } = await import('../src/commands.js');
    const tracker = new CommandTracker({ sessionId: 's', cwd: '/tmp' });
    tracker.feed('$ curl -H "Authorization: Bearer abcdefghijklmnopqrstu" x\n');
    expect(tracker.rows()[0]?.text).not.toContain('abcdefghijklmnopqrstu');
    const started = Date.now();
    tracker.feed(`${'a'.repeat(200_000)}\n`);
    expect(Date.now() - started).toBeLessThan(200);
  });
});
