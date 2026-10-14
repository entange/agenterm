import { beforeEach, describe, expect, it } from 'vitest';
import { useLive } from './live.js';

describe('live state', () => {
  beforeEach(() => useLive.setState({ lastLine: {} }));

  it('keeps the newest output line per task', () => {
    useLive.getState().seedActivity({ atMs: 1, tasks: { a: { samples: [], lastLine: 'old', lastOutputAtMs: 1 } } });
    useLive
      .getState()
      .applyTick({ atMs: 2, tasks: { a: { bytes: 4, lastLine: 'new' }, b: { bytes: 0, lastLine: null } } });
    expect(useLive.getState().lastLine).toEqual({ a: 'new' });
  });

  it('does not change state for a tick with nothing new', () => {
    useLive.setState({ lastLine: { a: 'same' } });
    const before = useLive.getState().lastLine;
    useLive.getState().applyTick({ atMs: 2, tasks: { a: { bytes: 0, lastLine: 'same' } } });
    expect(useLive.getState().lastLine).toBe(before);
  });

  it('forgets a removed task', () => {
    useLive.setState({ lastLine: { a: 'hi', b: 'yo' } });
    useLive.getState().forget('a');
    expect(useLive.getState().lastLine).toEqual({ b: 'yo' });
  });
});
