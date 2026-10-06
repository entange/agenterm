import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireLock, readLock } from '../src/lock.js';
import { loadOrCreateToken } from '../src/token.js';

describe('token and lock', () => {
  it('creates a token file with restricted mode', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenterm-token-'));
    const token = loadOrCreateToken(dir);
    expect(token.length).toBeGreaterThan(16);
    const second = loadOrCreateToken(dir);
    expect(second).toBe(token);
  });

  it('acquires a lock and a second caller becomes a client', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenterm-lock-'));
    const token = '0123456789abcdef0123456789abcdef';
    const first = await acquireLock({ dir, token, desiredPort: 0 });
    expect(first.isOwner).toBe(true);
    const second = await acquireLock({ dir, token, desiredPort: 0 });
    expect(second.isOwner).toBe(false);
    expect(second.lock.port).toBe(first.lock.port);
    expect(readLock(dir)?.port).toBe(first.lock.port);
  });
});

describe('stale locks', () => {
  it('replaces a lock whose pid is dead and releases only its own lock', async () => {
    const { releaseLock } = await import('../src/lock.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenterm-stale-'));
    fs.writeFileSync(
      path.join(dir, 'agentermd.lock'),
      JSON.stringify({ pid: 2_000_000, port: 1, tokenHash: 'x', startedAtMs: Date.now() })
    );
    const taken = await acquireLock({ dir, token: '0123456789abcdef0123456789abcdef', desiredPort: 0 });
    expect(taken.isOwner).toBe(true);
    expect(taken.lock.pid).toBe(process.pid);
    releaseLock(dir);
    expect(readLock(dir)).toBe(null);
  });

  it('replaces an old lock held by a live pid whose port does not answer', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenterm-reused-'));
    fs.writeFileSync(
      path.join(dir, 'agentermd.lock'),
      JSON.stringify({ pid: process.ppid, port: 9, tokenHash: 'x', startedAtMs: Date.now() - 60_000 })
    );
    const taken = await acquireLock({ dir, token: '0123456789abcdef0123456789abcdef', desiredPort: 0 });
    expect(taken.isOwner).toBe(true);
  });
});
