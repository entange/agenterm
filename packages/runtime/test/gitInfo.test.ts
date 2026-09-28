import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';
import { readGitInfo, sharedCwdSessions } from '../src/gitInfo.js';

describe('readGitInfo', () => {
  it('reads branch and root from a scratch repo', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenterm-git-'));
    const git = simpleGit(dir);
    await git.init();
    await git.addConfig('user.name', 'agenterm-test');
    await git.addConfig('user.email', 'test@example.com');
    fs.writeFileSync(path.join(dir, 'note.txt'), 'hello');
    await git.add('note.txt');
    await git.commit('first');
    await git.branch(['-M', 'work']);
    const info = await readGitInfo(dir);
    expect(info.branch).toBe('work');
    expect(info.worktreeRoot).toBe(fs.realpathSync(dir));
  });

  it('returns nulls outside a repo without throwing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenterm-plain-'));
    const info = await readGitInfo(dir);
    expect(info).toEqual({ branch: null, worktreeRoot: null });
  });
});

describe('sharedCwdSessions', () => {
  it('lists other sessions sharing the cwd', () => {
    const out = sharedCwdSessions('a', '/work', [
      { id: 'a', cwd: '/work' },
      { id: 'b', cwd: '/work' },
      { id: 'c', cwd: '/other' }
    ]);
    expect(out).toEqual(['b']);
  });
});
