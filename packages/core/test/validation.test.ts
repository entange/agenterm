import { describe, expect, it } from 'vitest';
import {
  parseAttachSessionRequest,
  parseListSessionsQuery,
  parseSessionInputRequest,
  parseSessionOutputQuery,
  parseSessionResizeRequest,
  parseSessionSignalRequest,
  parseSpawnSessionRequest
} from '../src/validation.js';

describe('spawn validation', () => {
  it('accepts a full generic spawn', () => {
    const out = parseSpawnSessionRequest({
      provider: 'generic',
      command: '/bin/echo',
      args: ['hello'],
      cwd: '/tmp',
      title: 'echo check',
      cols: 80,
      rows: 24,
      env: { TERM: 'xterm-256color' }
    });
    expect(out.ok).toBe(true);
  });

  it('rejects relative cwd', () => {
    const out = parseSpawnSessionRequest({ provider: 'claude', cwd: 'relative/path' });
    expect(out.ok).toBe(false);
  });

  it('rejects unknown provider', () => {
    const out = parseSpawnSessionRequest({ provider: 'nope', cwd: '/tmp' });
    expect(out.ok).toBe(false);
  });

  it('rejects oversized args', () => {
    const args = Array.from({ length: 201 }, (_, i) => `arg-${i}`);
    const out = parseSpawnSessionRequest({ provider: 'generic', cwd: '/tmp', args });
    expect(out.ok).toBe(false);
  });

  it('rejects bad dims', () => {
    const out = parseSpawnSessionRequest({ provider: 'generic', cwd: '/tmp', cols: 0 });
    expect(out.ok).toBe(false);
  });

  it('rejects non-object body without throwing', () => {
    expect(parseSpawnSessionRequest(null).ok).toBe(false);
    expect(parseSpawnSessionRequest('x').ok).toBe(false);
    expect(parseSpawnSessionRequest([]).ok).toBe(false);
  });
});

describe('attach validation', () => {
  it('accepts pid with title', () => {
    const out = parseAttachSessionRequest({ pid: 1234, title: 'codex outer' });
    expect(out.ok).toBe(true);
  });

  it('rejects zero pid', () => {
    expect(parseAttachSessionRequest({ pid: 0 }).ok).toBe(false);
  });

  it('rejects missing pid', () => {
    expect(parseAttachSessionRequest({}).ok).toBe(false);
  });

  it('rejects relative cwd hint', () => {
    expect(parseAttachSessionRequest({ pid: 10, cwd: 'rel' }).ok).toBe(false);
  });
});

describe('input resize signal output', () => {
  it('rejects empty input', () => {
    expect(parseSessionInputRequest({ data: '' }).ok).toBe(false);
  });

  it('accepts input bytes', () => {
    expect(parseSessionInputRequest({ data: 'hello\n' }).ok).toBe(true);
  });

  it('rejects out of range resize', () => {
    expect(parseSessionResizeRequest({ cols: 80, rows: 0 }).ok).toBe(false);
  });

  it('accepts resize', () => {
    expect(parseSessionResizeRequest({ cols: 120, rows: 30 }).ok).toBe(true);
  });

  it('rejects unknown signal', () => {
    expect(parseSessionSignalRequest({ signal: 'hangup' }).ok).toBe(false);
  });

  it('accepts known signals', () => {
    expect(parseSessionSignalRequest({ signal: 'interrupt' }).ok).toBe(true);
    expect(parseSessionSignalRequest({ signal: 'terminate' }).ok).toBe(true);
    expect(parseSessionSignalRequest({ signal: 'kill' }).ok).toBe(true);
  });

  it('applies output defaults', () => {
    const out = parseSessionOutputQuery({});
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.tailBytes).toBe(65_536);
      expect(out.value.limit).toBe(200);
    }
  });

  it('rejects bad sinceSeq', () => {
    expect(parseSessionOutputQuery({ sinceSeq: -1 }).ok).toBe(false);
  });
});

describe('list filters', () => {
  it('accepts empty filters', () => {
    expect(parseListSessionsQuery({}).ok).toBe(true);
  });

  it('rejects unknown lifecycle', () => {
    expect(parseListSessionsQuery({ lifecycle: 'sleeping' }).ok).toBe(false);
  });

  it('accepts provider filter', () => {
    const out = parseListSessionsQuery({ provider: 'codex' });
    expect(out.ok).toBe(true);
  });
});
