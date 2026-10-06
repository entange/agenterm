import fs from 'node:fs';
import path from 'node:path';
import { parseClaudeHarnessPayload } from '@agenterm/core';
import { newestFiles, parseTail, type HarnessAdapter } from './types.js';

/**
 * Claude adapter (read-only, flagged).
 *
 * Reads transcript JSONL under granted roots, mirroring the
 * ~/.claude/projects/<slug>/*.jsonl layout. Lenient: any mismatch
 * yields unknown and never throws into the event bus.
 */
/** Claude names each project folder after its cwd with non-alphanumerics as dashes. */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

export const claudeAdapter: HarnessAdapter = {
  provider: 'claude',
  discoverFiles: (grantedRoots: string[], cwd?: string) => {
    if (cwd !== undefined) {
      // Only this session's project folder: never another project's transcript.
      const scoped: string[] = [];
      for (const root of grantedRoots) {
        for (const base of [path.join(root, 'projects'), root]) {
          scoped.push(...newestFiles(path.join(base, claudeProjectSlug(cwd)), '.jsonl', 2));
        }
      }
      return scoped.slice(0, 2);
    }
    const out: string[] = [];
    for (const root of grantedRoots) {
      const projects = path.join(root, 'projects');
      const base = (() => {
        try {
          return fs.statSync(projects).isDirectory() ? projects : root;
        } catch {
          return root;
        }
      })();
      out.push(...newestFiles(base, '.jsonl', 5));
      if (base !== root) continue;
      let slugs: string[] = [];
      try {
        slugs = fs.readdirSync(root);
      } catch {
        continue;
      }
      for (const slug of slugs.slice(0, 20)) {
        const dir = path.join(root, slug);
        try {
          if (fs.statSync(dir).isDirectory()) out.push(...newestFiles(dir, '.jsonl', 2));
        } catch {
          // Skip unreadable entries.
        }
      }
    }
    return out.slice(0, 5);
  },
  parseText: (text) => parseTail(text, parseClaudeHarnessPayload)
};
