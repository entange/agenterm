import { describe, expect, it } from 'vitest';
import { lastVisibleLine } from '../src/terminalText.js';

describe('lastVisibleLine', () => {
  it('strips colors and keeps the last non-empty line', () => {
    expect(lastVisibleLine('\x1b[32m✓\x1b[0m test 1 passed\r\n\r\n')).toBe('✓ test 1 passed');
  });

  it('follows carriage-return redraws and OSC titles', () => {
    expect(lastVisibleLine('\x1b]0;title\x07progress 10%\rprogress 90%')).toBe('progress 90%');
  });

  it('returns null for blank output', () => {
    expect(lastVisibleLine('\x1b[2J\r\n   \r\n')).toBe(null);
  });
});
