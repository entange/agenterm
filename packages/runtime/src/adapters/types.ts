import fs from 'node:fs';
import path from 'node:path';
import type { HarnessParseOutcome, HarnessProvider } from '@agenterm/core';

/** Candidate transcript files found under granted roots. No reads yet. */
export interface HarnessAdapter {
  provider: HarnessProvider;
  discoverFiles: (grantedRoots: string[]) => string[];
  parseText: (text: string | null) => HarnessParseOutcome;
}

/** Read at most maxBytes from the end of a file. Null on any failure. */
export function tailFile(file: string, maxBytes = 65536): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(file, 'r');
    try {
      const length = Math.min(stat.size, maxBytes);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      return buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Newest-first file listing for one directory level. Empty on any failure. */
export function newestFiles(dir: string, suffix: string, cap: number): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const files: Array<{ file: string; mtime: number }> = [];
  for (const entry of entries) {
    if (!entry.endsWith(suffix)) continue;
    const file = path.join(dir, entry);
    try {
      const stat = fs.statSync(file);
      if (stat.isFile()) files.push({ file, mtime: stat.mtimeMs });
    } catch {
      // Skip unreadable entries.
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files.slice(0, cap).map((entry) => entry.file);
}

/**
 * Parse transcript tail text through a core parser.
 *
 * Tries each line newest-first as JSON, then falls back to the raw blob.
 * Never throws: unparseable input yields unknown via the core parser.
 */
export function parseTail(
  text: string | null,
  parse: (payload: unknown) => HarnessParseOutcome
): HarnessParseOutcome {
  if (text === null || text.trim().length === 0) {
    return parse(null);
  }
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    try {
      const outcome = parse(JSON.parse(line) as unknown);
      if (outcome.overlay !== 'unknown' || outcome.summary !== null) return outcome;
    } catch {
      // Not JSON; keep scanning older lines.
    }
  }
  return parse({ text });
}
