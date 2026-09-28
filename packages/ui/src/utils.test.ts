import { describe, expect, it } from 'vitest';
import { lifecycleColor, overlayColor, cn } from './utils.js';

describe('ui utils', () => {
  it('maps lifecycle to color', () => {
    expect(lifecycleColor('running')).toContain('emerald');
    expect(lifecycleColor('exited')).toContain('zinc');
  });

  it('maps overlay to color', () => {
    expect(overlayColor('working')).toContain('sky');
    expect(overlayColor('unknown')).toContain('zinc');
  });

  it('merges classes', () => {
    expect(cn('a', 'b')).toBe('a b');
  });
});
