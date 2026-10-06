import { describe, expect, it } from 'vitest';
import { cn, signalBg, signalText } from './utils.js';

describe('ui utils', () => {
  it('merges classes with conflict resolution', () => {
    expect(cn('a', 'b')).toBe('a b');
    expect(cn('px-2', false, 'px-3')).toBe('px-3');
  });

  it('maps every signal to text and background classes', () => {
    expect(Object.keys(signalText)).toEqual(Object.keys(signalBg));
    expect(signalBg.attn).toBe('bg-attn');
  });
});
