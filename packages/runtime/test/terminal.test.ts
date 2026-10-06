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
    expect(out.hasMore).toBe(false);
    expect(out.firstSeq).toBe(1);
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

describe('TerminalLog cursor paging', () => {
  it('pages forward from a cursor without skipping past the tail budget', () => {
    const log = new TerminalLog({ maxBytes: 1024 * 1024 });
    for (let i = 1; i <= 50; i++) log.append(`chunk-${i}`);
    const seen: number[] = [];
    let cursor = 0;
    for (;;) {
      const page = log.read({ sinceSeq: cursor, tailBytes: 16, limit: 7 });
      seen.push(...page.chunks.map((c) => c.seq));
      if (!page.hasMore || page.resumeAfterSeq === null) break;
      cursor = page.resumeAfterSeq;
    }
    expect(seen).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it('reports firstSeq so callers can detect evicted data', () => {
    const log = new TerminalLog({ maxBytes: 10 });
    for (let i = 0; i < 5; i++) log.append('abcde');
    const page = log.read({ sinceSeq: 0 });
    expect(page.firstSeq).toBe(4);
    expect(page.chunks.map((c) => c.seq)).toEqual([4, 5]);
  });

  it('keeps the newest chunk even when it alone exceeds the cap', () => {
    const log = new TerminalLog({ maxBytes: 4 });
    log.append('0123456789');
    expect(log.read().chunks.map((c) => c.data)).toEqual(['0123456789']);
  });
});

describe('readLogTail', () => {
  it('returns the tail on a line boundary and null when missing', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenterm-tail-'));
    const file = path.join(dir, 'terminal.log');
    const log = new TerminalLog({ file });
    log.append('first line\r\n');
    log.append('second line\r\n');
    log.append('third');
    log.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const { readLogTail } = await import('../src/terminal.js');
    expect(readLogTail(file)).toBe('first line\r\nsecond line\r\nthird');
    expect(readLogTail(file, 20)).toBe('second line\r\nthird');
    expect(readLogTail(path.join(dir, 'missing.log'))).toBe(null);
  });
});
