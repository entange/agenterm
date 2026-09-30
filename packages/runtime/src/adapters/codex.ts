import fs from 'node:fs';
import path from 'node:path';
import { parseCodexHarnessPayload } from '@agenterm/core';
import { newestFiles, parseTail, type HarnessAdapter } from './types.js';

function walkJsonl(dir: string, depth: number, out: string[]): void {
  if (depth < 0 || out.length >= 8) return;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    try {
      const stat = fs.statSync(full);
      if (stat.isFile() && entry.endsWith('.jsonl')) {
        out.push(full);
      } else if (stat.isDirectory() && !entry.startsWith('.')) {
        walkJsonl(full, depth - 1, out);
      }
    } catch {
      // Skip unreadable entries.
    }
    if (out.length >= 8) return;
  }
}

/**
 * Codex adapter (read-only, flagged).
 *
 * Reads session JSONL under granted roots, mirroring the sessions
 * directory layout. SQLite stores are never opened in place; this
 * adapter only tails plain transcript files.
 */
export const codexAdapter: HarnessAdapter = {
  provider: 'codex',
  discoverFiles: (grantedRoots: string[]) => {
    const out: string[] = [];
    for (const root of grantedRoots) {
      const sessions = path.join(root, 'sessions');
      let base = root;
      try {
        if (fs.statSync(sessions).isDirectory()) base = sessions;
      } catch {
        base = root;
      }
      const found: string[] = [];
      walkJsonl(base, 3, found);
      out.push(...newestFiles(base, '.jsonl', 2));
      out.push(...found);
    }
    const ranked = out
      .map((file) => {
        try {
          return { file, mtime: fs.statSync(file).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((entry) => entry !== null);
    ranked.sort((a, b) => b.mtime - a.mtime);
    return ranked.slice(0, 5).map((entry) => entry.file);
  },
  parseText: (text) => parseTail(text, parseCodexHarnessPayload)
};
