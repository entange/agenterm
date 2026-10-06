import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileWatch, type WatchedChange } from '../src/fileWatch.js';

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
        reject(new Error('timed out waiting for watcher'));
      }
    }, 50);
  });
}

describe('FileWatch', () => {
  it('reports added, modified, and deleted files debounced', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenterm-watch-'));
    const seen: WatchedChange[] = [];
    const watch = new FileWatch({ debounceMs: 100, onChange: (change) => seen.push(change) });
    try {
      watch.track('s1', dir);
      await new Promise((resolve) => setTimeout(resolve, 400));
      fs.writeFileSync(path.join(dir, 'note.txt'), 'v1\n');
      await waitFor(() => seen.some((entry) => entry.change === 'added'));
      fs.writeFileSync(path.join(dir, 'note.txt'), 'v2\n');
      await waitFor(() => seen.some((entry) => entry.change === 'modified'));
      fs.unlinkSync(path.join(dir, 'note.txt'));
      await waitFor(() => seen.some((entry) => entry.change === 'deleted'));
      expect(seen[0]?.sessionId).toBe('s1');
    } finally {
      await watch.close();
    }
  });

  it('ignores node_modules and shares one watcher per cwd', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenterm-watch-'));
    fs.mkdirSync(path.join(dir, 'node_modules', 'lib'), { recursive: true });
    const seen: WatchedChange[] = [];
    const watch = new FileWatch({ debounceMs: 50, onChange: (change) => seen.push(change) });
    try {
      watch.track('s1', dir);
      watch.track('s2', dir);
      expect(watch.watcherCount()).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 400));
      fs.writeFileSync(path.join(dir, 'node_modules', 'lib', 'x.js'), 'ignored\n');
      fs.writeFileSync(path.join(dir, 'real.txt'), 'seen\n');
      await waitFor(() => seen.some((entry) => entry.path.endsWith('real.txt')));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(seen.every((entry) => !entry.path.includes('node_modules'))).toBe(true);
      expect(
        seen
          .filter((entry) => entry.path.endsWith('real.txt'))
          .map((entry) => entry.sessionId)
          .sort()
      ).toEqual(['s1', 's2']);
      watch.untrack('s1');
      expect(watch.watcherCount()).toBe(1);
      watch.untrack('s2');
      expect(watch.watcherCount()).toBe(0);
    } finally {
      await watch.close();
    }
  });
});
