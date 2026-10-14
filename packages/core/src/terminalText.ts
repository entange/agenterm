import { redactText } from './redaction.js';

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/**
 * Last visible line of terminal text, without escape codes.
 *
 * A carriage return redraws the line, so the last non-empty segment after
 * the final `\r` is what the screen shows. Returns null when nothing is
 * visible. Used for "what is it doing right now" summaries.
 */
export function lastVisibleLine(text: string): string | null {
  const plain = text.replace(ANSI, '');
  const lines = plain.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const segments = (lines[i] ?? '').split('\r');
    for (let j = segments.length - 1; j >= 0; j--) {
      const visible = (segments[j] ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim();
      if (visible.length > 0) return visible.slice(0, 200);
    }
  }
  return null;
}

/**
 * Terminal bytes as readable text for logs and agents: escape codes
 * removed, carriage-return redraws (progress bars) collapsed to what the
 * screen finally showed, and secrets masked.
 */
export function plainText(data: string): string {
  const lines = data.replace(ANSI, '').split('\n');
  return redactText(
    lines
      .map((line) => {
        const segments = line.split('\r').filter((segment) => segment.length > 0);
        return segments[segments.length - 1] ?? '';
      })
      .join('\n')
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  );
}
