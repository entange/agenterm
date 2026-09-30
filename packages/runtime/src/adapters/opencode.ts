import fs from 'node:fs';
import path from 'node:path';
import { parseOpencodeHarnessPayload } from '@agenterm/core';
import { newestFiles, parseTail, type HarnessAdapter } from './types.js';

/**
 * Opencode adapter (read-only, flagged).
 *
 * The sqlite store is never opened in place. This adapter tails plain
 * JSON session exports under granted roots when present; with no files
 * it yields unknown, matching the unpinned-schema rule.
 */
export const opencodeAdapter: HarnessAdapter = {
  provider: 'opencode',
  discoverFiles: (grantedRoots: string[]) => {
    const out: string[] = [];
    for (const root of grantedRoots) {
      out.push(...newestFiles(root, '.json', 5));
      let entries: string[] = [];
      try {
        entries = fs.readdirSync(root);
      } catch {
        continue;
      }
      for (const entry of entries.slice(0, 20)) {
        const dir = path.join(root, entry);
        try {
          if (fs.statSync(dir).isDirectory()) out.push(...newestFiles(dir, '.json', 2));
        } catch {
          // Skip unreadable entries.
        }
      }
    }
    return out.slice(0, 5);
  },
  parseText: (text) => parseTail(text, parseOpencodeHarnessPayload)
};
