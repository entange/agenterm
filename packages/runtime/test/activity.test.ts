import { describe, expect, it } from 'vitest';
import { ACTIVITY_WINDOW_SECONDS, ActivityMeter } from '../src/activity.js';

describe('ActivityMeter', () => {
  it('buckets bytes per second over the window with the last line', () => {
    let now = 1_000_000;
    const meter = new ActivityMeter(() => now);
    meter.record('s', 'abc\r\n');
    now += 1000;
    meter.record('s', '\x1b[31mfail\x1b[0m\n');
    now += 500;
    const snap = meter.snapshot().sessions['s'];
    expect(snap?.samples).toHaveLength(ACTIVITY_WINDOW_SECONDS);
    expect(snap?.samples.slice(-2)).toEqual([5, 14]);
    expect(snap?.lastLine).toBe('fail');
    expect(snap?.lastOutputAtMs).toBe(1_001_000);
  });

  it('drops buckets that leave the window and forgets closed sessions', () => {
    let now = 0;
    const meter = new ActivityMeter(() => now);
    meter.record('s', 'x');
    now += (ACTIVITY_WINDOW_SECONDS + 5) * 1000;
    expect(meter.snapshot().sessions['s']?.samples.every((value) => value === 0)).toBe(true);
    meter.forget('s');
    expect(meter.snapshot().sessions['s']).toBe(undefined);
  });
});
