import { describe, expect, it } from 'vitest';
import { folderName, formatAge, formatDuration, runtimeText, shortPath, signalOf } from './format.js';

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
    expect(folderName('/srv/app/')).toBe('app');
  });

  it('colors tasks by status', () => {
    expect(signalOf({ status: 'running' })).toBe('ok');
    expect(signalOf({ status: 'failed' })).toBe('fail');
    expect(signalOf({ status: 'stopped' })).toBe('idle');
    expect(signalOf({ status: 'lost' })).toBe('attn');
  });

  it('says how long a task has been up or ran', () => {
    expect(runtimeText({ startedAtMs: 0, endedAtMs: null }, 65_000)).toBe('up 1m 05s');
    expect(runtimeText({ startedAtMs: 0, endedAtMs: 1500 }, 99_000)).toBe('ran 1.5s');
  });
});
