import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addGrant, loadGrants, revokeGrant, rootsFor } from '../src/grants.js';

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agenterm-grants-'));
}

describe('grants file', () => {
  it('adds, lists, and revokes approvals', () => {
    const dir = scratch();
    expect(loadGrants(dir)).toEqual([]);
    const grant = addGrant(dir, 'claude', path.join(dir, 'home'));
    expect(grant.provider).toBe('claude');
    expect(loadGrants(dir)).toHaveLength(1);
    expect(rootsFor(loadGrants(dir), 'claude')).toEqual([path.join(dir, 'home')]);
    expect(rootsFor(loadGrants(dir), 'codex')).toEqual([]);
    expect(addGrant(dir, 'claude', path.join(dir, 'home')).grantedAtMs).toBe(grant.grantedAtMs);
    expect(revokeGrant(dir, 'claude', path.join(dir, 'home'))).toBe(true);
    expect(loadGrants(dir)).toEqual([]);
    expect(revokeGrant(dir, 'claude', path.join(dir, 'home'))).toBe(false);
  });

  it('rejects relative paths', () => {
    expect(() => addGrant(scratch(), 'codex', 'relative/path')).toThrow();
  });

  it('reads corrupt files as empty', () => {
    const dir = scratch();
    fs.writeFileSync(path.join(dir, 'harness-grants.json'), 'not json{{{');
    expect(loadGrants(dir)).toEqual([]);
  });
});
