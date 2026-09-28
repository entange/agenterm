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
