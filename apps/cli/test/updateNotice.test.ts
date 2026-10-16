import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { updateNotice, wantsUpdateCheck } from '../src/updateNotice.js';

const npm = (version: string) => (async () => new Response(JSON.stringify({ version }))) as unknown as typeof fetch;

describe('updateNotice', () => {
  it('says when npm has a newer version, then stays quiet for a day', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenterm-notice-'));
    const now = 1_000_000_000;
    expect(await updateNotice('0.4.0', dir, { now, fetchImpl: npm('0.10.0') })).toBe(
      'agenterm 0.10.0 is out (you have 0.4.0). Update with: npm install -g agenterm'
    );
    expect(await updateNotice('0.4.0', dir, { now: now + 3600_000, fetchImpl: npm('0.10.0') })).toBeNull();
    expect(await updateNotice('0.4.0', dir, { now: now + 25 * 3600_000, fetchImpl: npm('0.4.0') })).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('gives up quietly offline', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenterm-notice-'));
    const offline = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await updateNotice('0.4.0', dir, { fetchImpl: offline })).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('only checks for a person at a terminal', () => {
    expect(wantsUpdateCheck(['ls'], {}, true)).toBe(true);
    expect(wantsUpdateCheck(['ls'], {}, false)).toBe(false);
    expect(wantsUpdateCheck(['mcp'], {}, true)).toBe(false);
    expect(wantsUpdateCheck(['ps', '--json'], {}, true)).toBe(false);
    expect(wantsUpdateCheck(['ls'], { CI: 'true' }, true)).toBe(false);
  });
});
