import { describe, expect, it } from 'vitest';
import {
  parseRunTaskRequest,
  parseStopTaskRequest,
  parseTaskId,
  parseTaskInputRequest,
  parseTaskOutputQuery,
  parseTaskResizeRequest
} from '../src/validation.js';

describe('run validation', () => {
  it('accepts a bare command and folder', () => {
    expect(parseRunTaskRequest({ command: ' npm run dev ', cwd: '/repo' })).toEqual({
      ok: true,
      value: { command: 'npm run dev', cwd: '/repo' }
    });
  });

  it('accepts every optional field and normalizes the id', () => {
    const out = parseRunTaskRequest({
      command: 'npm run dev',
      cwd: '/repo',
      id: ' Web ',
      title: 'dev server',
      startedBy: 'claude',
      startedByPid: 42,
      env: { PATH: '/bin', DATABASE_URL: 'postgres://x' },
      restart: true,
      cols: 120,
      rows: 30
    });
    expect(out.ok && out.value.id).toBe('web');
    expect(out.ok && out.value.env?.['DATABASE_URL']).toBe('postgres://x');
  });

  it('rejects bad input', () => {
    expect(parseRunTaskRequest({ command: '', cwd: '/repo' }).ok).toBe(false);
    expect(parseRunTaskRequest({ command: 'ls', cwd: 'relative' }).ok).toBe(false);
    expect(parseRunTaskRequest({ command: 'ls', cwd: '/repo', id: '../etc' }).ok).toBe(false);
    expect(parseRunTaskRequest({ command: 'ls', cwd: '/repo', env: { A: 1 } }).ok).toBe(false);
    expect(parseRunTaskRequest({ command: 'ls', cwd: '/repo', startedByPid: -1 }).ok).toBe(false);
    expect(parseRunTaskRequest([]).ok).toBe(false);
  });
});

describe('task ids', () => {
  it('allows short safe names only', () => {
    expect(parseTaskId('npm-run-dev-3f9a')).toEqual({ ok: true, value: 'npm-run-dev-3f9a' });
    expect(parseTaskId('a.b_c').ok).toBe(true);
    for (const bad of ['', '-x', 'a/b', 'a b', '.', 'x'.repeat(65)]) expect(parseTaskId(bad).ok).toBe(false);
  });
});

describe('other bodies', () => {
  it('validates stop, input, resize, and output', () => {
    expect(parseStopTaskRequest(undefined)).toEqual({ ok: true, value: {} });
    expect(parseStopTaskRequest({ force: 'yes' }).ok).toBe(false);
    expect(parseTaskInputRequest({ data: '' }).ok).toBe(false);
    expect(parseTaskResizeRequest({ cols: 0, rows: 10 }).ok).toBe(false);
    expect(parseTaskOutputQuery({ sinceSeq: '7' })).toEqual({ ok: true, value: { tailBytes: 65536, limit: 200, sinceSeq: 7 } });
    expect(parseTaskOutputQuery({ limit: '0' }).ok).toBe(false);
  });
});
