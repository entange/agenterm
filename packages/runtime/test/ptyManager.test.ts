import { describe, expect, it } from 'vitest';
import { PtyManager } from '../src/ptyManager.js';

function waitFor(condition: () => boolean, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (condition()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error('timed out waiting for PTY condition'));
      }
    }, 25);
  });
}

describe('PtyManager with a real PTY', () => {
  it('spawns echo, captures output, and records the exit', async () => {
    const seen: string[] = [];
    const exits: Array<{ exitCode: number }> = [];
    const manager = new PtyManager({
      onOutput: (_id, data) => seen.push(data),
      onExit: (_id, exit) => exits.push(exit)
    });
    const record = manager.spawn({
      sessionId: 'echo-check',
      file: '/bin/echo',
      args: ['hello-pty'],
      cwd: '/tmp',
      env: { ['PATH']: process.env['PATH'] ?? '/usr/bin:/bin' },
      cols: 80,
      rows: 24
    });
    expect(record.pid).toBeGreaterThan(0);
    await waitFor(() => seen.join('').includes('hello-pty'));
    await waitFor(() => record.exit !== null);
    expect(record.exit?.exitCode).toBe(0);
    const out = record.log.read({ tailBytes: 65536 });
    expect(out.chunks.length).toBeGreaterThan(0);
    manager.forget('echo-check');
    expect(manager.has('echo-check')).toBe(false);
  });

  it('writes stdin to a shell and resizes without error', async () => {
    const seen: string[] = [];
    const manager = new PtyManager({ onOutput: (_id, data) => seen.push(data) });
    manager.spawn({
      sessionId: 'shell-check',
      file: '/bin/sh',
      args: [],
      cwd: '/tmp',
      env: { ['PATH']: process.env['PATH'] ?? '/usr/bin:/bin' },
      cols: 80,
      rows: 24
    });
    manager.resize('shell-check', 100, 30);
    manager.write('shell-check', 'echo stdin-works\n');
    await waitFor(() => seen.join('').includes('stdin-works'));
    manager.kill('shell-check');
    manager.forget('shell-check');
  });

  it('rejects writes to unknown sessions', () => {
    const manager = new PtyManager();
    expect(() => manager.write('missing', 'x')).toThrow();
    expect(() => manager.resize('missing', 80, 24)).toThrow();
  });
});

describe('signalName', () => {
  it('maps numbers to names and treats 0 as no signal', async () => {
    const { signalName } = await import('../src/ptyManager.js');
    expect(signalName(0)).toBe(null);
    expect(signalName(undefined)).toBe(null);
    expect(signalName(15)).toBe('SIGTERM');
    expect(signalName(9)).toBe('SIGKILL');
  });
});
