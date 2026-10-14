import { describe, expect, it } from 'vitest';
import { findTask, statusText } from '../src/task.js';
import { plainText } from '../src/terminalText.js';

const tasks = [
  { id: 'web', title: 'dev server', status: 'running' as const },
  { id: 'web-old', title: 'dev server', status: 'exited' as const },
  { id: 'tests-1a2b', title: 'vitest --watch', status: 'running' as const }
];

describe('findTask', () => {
  it('matches id, then title, then a unique prefix', () => {
    expect(findTask(tasks, 'WEB').id).toBe('web');
    expect(findTask(tasks, 'Dev Server').id).toBe('web');
    expect(findTask(tasks, 'tests').id).toBe('tests-1a2b');
  });

  it('names the candidates when ambiguous, and fails clearly when nothing matches', () => {
    expect(() => findTask(tasks, 'we')).toThrow('web, web-old');
    expect(() => findTask(tasks, 'nope')).toThrow('no task matches "nope"');
    expect(() => findTask(tasks, ' ')).toThrow('required');
  });
});

describe('statusText', () => {
  it('reads like a person would say it', () => {
    expect(statusText({ status: 'failed', exitCode: 1, exitSignal: null })).toBe('failed (exit 1)');
    expect(statusText({ status: 'failed', exitCode: null, exitSignal: 'SIGSEGV' })).toBe('failed (SIGSEGV)');
    expect(statusText({ status: 'exited', exitCode: 0, exitSignal: null })).toBe('finished');
  });
});

describe('plainText', () => {
  it('strips escapes, collapses redraws, and masks secrets', () => {
    expect(plainText('\x1b[32mok\x1b[0m 40%\r100%\r\ntoken sk-abcdefghijklmnopqrst\r\n')).toBe(
      '100%\ntoken [REDACTED]\n'
    );
  });
});
