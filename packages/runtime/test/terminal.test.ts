import { describe, expect, it } from 'vitest';
import { TerminalLog } from '../src/terminal.js';

describe('TerminalLog', () => {
  it('assigns rising sequence numbers', () => {
    const log = new TerminalLog({ maxBytes: 1024 });
    const a = log.append('hello');
    const b = log.append(' world');
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(log.latestSeq()).toBe(2);
  });

  it('reads the tail by byte budget', () => {
    const log = new TerminalLog({ maxBytes: 1024 });
    log.append('aaa');
    log.append('bbb');
    const out = log.read({ tailBytes: 3 });
    expect(out.chunks.map((c) => c.data)).toEqual(['bbb']);
    expect(out.resumeAfterSeq).toBe(2);
    expect(out.hasMore).toBe(true);
  });

  it('resumes from a cursor', () => {
    const log = new TerminalLog({ maxBytes: 1024 });
    log.append('one');
    log.append('two');
    log.append('three');
    const out = log.read({ sinceSeq: 1, tailBytes: 1024, limit: 10 });
    expect(out.chunks.map((c) => c.seq)).toEqual([2, 3]);
    expect(out.hasMore).toBe(false);
  });

  it('pages with a chunk limit', () => {
    const log = new TerminalLog({ maxBytes: 1024 });
    for (let i = 0; i < 5; i++) log.append(`line-${i}`);
    const first = log.read({ tailBytes: 1024, limit: 2 });
    expect(first.chunks).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const rest = log.read({ sinceSeq: first.resumeAfterSeq ?? 0, tailBytes: 1024, limit: 10 });
    expect(rest.chunks.map((c) => c.seq)).toEqual([3, 4, 5]);
    expect(rest.hasMore).toBe(false);
  });

  it('evicts old bytes past the cap', () => {
    const log = new TerminalLog({ maxBytes: 8 });
    log.append('12345');
    log.append('67890');
    const out = log.read({ tailBytes: 1024 });
    const joined = out.chunks.map((c) => c.data).join('');
    expect(joined).toBe('67890');
    expect(log.latestSeq()).toBe(2);
  });
});
