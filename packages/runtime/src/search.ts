import { redactText } from '@agenterm/core';

// Escape sequences and stray control bytes, removed before matching.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

export interface TextMatch {
  /** 1-based line number within the searched text. */
  line: number;
  /** The visible line, redacted and capped. */
  text: string;
}

/**
 * Case-insensitive substring search over terminal text as the screen shows
 * it: escape codes removed and carriage-return redraws collapsed to their
 * final segment. Returns at most `limit` matches, newest last.
 */
export function searchTerminalText(raw: string, query: string, limit: number): TextMatch[] {
  const needle = query.toLowerCase();
  if (needle.length === 0) return [];
  const out: TextMatch[] = [];
  const lines = raw.replace(ANSI, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const segments = (lines[i] ?? '').split('\r').filter((segment) => segment.length > 0);
    const visible = (segments[segments.length - 1] ?? '').replace(CONTROL, '').trim();
    if (visible.length === 0 || !visible.toLowerCase().includes(needle)) continue;
    out.push({ line: i + 1, text: redactText(visible).slice(0, 300) });
  }
  return out.slice(-limit);
}
