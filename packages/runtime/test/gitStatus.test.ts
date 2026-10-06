import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';
import { readGitStatus } from '../src/gitStatus.js';

async function scratchRepo(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenterm-gitstatus-'));
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig('user.name', 'agenterm-test');
  await git.addConfig('user.email', 'test@example.com');
  fs.writeFileSync(path.join(dir, 'base.txt'), 'one\n');
  await git.add('base.txt');
  await git.commit('first');
  await git.branch(['-M', 'work']);
  return dir;
}

describe('readGitStatus', () => {
  it('reports branch, staged, modified, and untracked files', async () => {
    const dir = await scratchRepo();
    fs.writeFileSync(path.join(dir, 'base.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'fresh\n');
    await simpleGit(dir).add('base.txt');
    const status = await readGitStatus(dir);
    expect(status.branch).toBe('work');
    expect(status.worktreeRoot).toBe(fs.realpathSync(dir));
    expect(status.isDirty).toBe(true);
    expect(status.stagedCount).toBe(1);
    expect(status.unstagedCount).toBe(1);
    const byPath = new Map(status.files.map((file) => [path.basename(file.path), file]));
    expect(byPath.get('base.txt')?.staged).toBe('modified');
    expect(byPath.get('base.txt')?.unstaged).toBe(null);
    expect(byPath.get('new.txt')?.unstaged).toBe('untracked');
  });

  it('reports diff totals', async () => {
    const dir = await scratchRepo();
    fs.writeFileSync(path.join(dir, 'base.txt'), 'one\ntwo\nthree\n');
    await simpleGit(dir).add('base.txt');
    const status = await readGitStatus(dir);
    expect(status.insertions).toBeGreaterThanOrEqual(2);
    expect(status.deletions).toBe(0);
  });

  it('counts a file staged then edited again on both sides', async () => {
    const dir = await scratchRepo();
    fs.writeFileSync(path.join(dir, 'base.txt'), 'one\ntwo\n');
    await simpleGit(dir).add('base.txt');
    fs.writeFileSync(path.join(dir, 'base.txt'), 'one\ntwo\nthree\n');
    const status = await readGitStatus(dir);
    expect(status.stagedCount).toBe(1);
    expect(status.unstagedCount).toBe(1);
    expect(status.files).toEqual([{ path: 'base.txt', staged: 'modified', unstaged: 'modified' }]);
    expect(status.insertions).toBe(2);
  });

  it('reports clean repos as not dirty', async () => {
    const dir = await scratchRepo();
    const status = await readGitStatus(dir);
    expect(status.isDirty).toBe(false);
    expect(status.files).toEqual([]);
  });

  it('returns empty status outside a repo without throwing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenterm-plain-'));
    const status = await readGitStatus(dir);
    expect(status.branch).toBe(null);
    expect(status.isDirty).toBe(false);
  });
});
