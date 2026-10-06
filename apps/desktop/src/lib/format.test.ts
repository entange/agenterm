import { describe, expect, it } from 'vitest';
import { formatAge, formatDuration, shortPath, splitArgs } from './format.js';

describe('format', () => {
  it('formats ages and durations', () => {
    expect(formatAge(0, 2000)).toBe('now');
    expect(formatAge(0, 125_000)).toBe('2m');
    expect(formatDuration(850)).toBe('850ms');
    expect(formatDuration(65_000)).toBe('1m 05s');
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
});
