import { describe, expect, it } from 'vitest';
import { compactCommand, formatAge, formatCost, formatDuration, formatTokens, shortPath, splitArgs } from './format.js';

describe('format', () => {
  it('formats ages and durations', () => {
    expect(formatAge(0, 2000)).toBe('now');
    expect(formatAge(0, 125_000)).toBe('2m');
    expect(formatDuration(850)).toBe('850ms');
    expect(formatDuration(65_000)).toBe('1m 05s');
  });

  it('formats spend and token counts', () => {
    expect(formatCost(0)).toBe('$0');
    expect(formatCost(0.004)).toBe('<$0.01');
    expect(formatCost(1.234)).toBe('$1.23');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_345)).toBe('12k');
    expect(formatTokens(1_250_000)).toBe('1.3M');
  });

  it('shortens home paths', () => {
    expect(shortPath('/Users/me/code/app')).toBe('~/code/app');
    expect(shortPath('/srv/app')).toBe('/srv/app');
  });

  it('splits arguments with quotes and escapes', () => {
    expect(splitArgs('--model opus -p "fix the tests" \'a b\' c\\ d')).toEqual([
      '--model',
      'opus',
      '-p',
      'fix the tests',
      'a b',
      'c d'
    ]);
    expect(splitArgs('  ')).toEqual([]);
    expect(splitArgs('""')).toEqual(['']);
  });

  it('drops the executable directory from process commands', () => {
    expect(compactCommand('/opt/homebrew/bin/python3 -m http.server 8765')).toBe('python3 -m http.server 8765');
    expect(compactCommand('node server.js')).toBe('node server.js');
    expect(compactCommand('')).toBe('');
  });
});
