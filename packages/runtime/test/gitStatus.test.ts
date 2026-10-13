import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';
import { readGitDiff, readGitStatus, safeRelativePath } from '../src/gitStatus.js';

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

describe('readGitDiff', () => {
  it('diffs tracked edits against HEAD and untracked files against empty', async () => {
    const dir = await scratchRepo();
    fs.writeFileSync(path.join(dir, 'base.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'fresh\n');
    const tracked = await readGitDiff(dir, 'base.txt');
    expect(tracked?.diff).toContain('+two');
    const untracked = await readGitDiff(dir, 'new.txt');
    expect(untracked?.diff).toContain('+fresh');
    expect(untracked?.truncated).toBe(false);
  });

  it('refuses paths outside the worktree', async () => {
    const dir = await scratchRepo();
    expect(await readGitDiff(dir, '../outside.txt')).toBe(null);
    expect(await readGitDiff(dir, '/etc/passwd')).toBe(null);
    expect(safeRelativePath('/repo', 'a/../../b')).toBe(null);
    expect(safeRelativePath('/repo', 'src/a.ts')).toBe('src/a.ts');
  });
});

describe('a folder that no longer exists', () => {
  it('reads as not a repository instead of throwing', async () => {
    const gone = path.join(os.tmpdir(), `agenterm-gone-${process.pid}-${Date.now()}`);
    const status = await readGitStatus(gone);
    expect(status.branch).toBe(null);
    expect(status.files).toEqual([]);
    expect(await readGitDiff(gone, 'a.txt')).toBe(null);
  });
});
