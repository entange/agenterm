import type { AgentermEvent } from '@agenterm/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { useLive } from './live.js';

let next = 0;
function fileEvent(sessionId: string, path: string): AgentermEvent {
  next += 1;
  return { kind: 'file.changed', id: `e${next}`, sessionId, createdAtMs: next, path, change: 'modified' };
}

describe('live feed', () => {
  beforeEach(() => useLive.setState({ feed: [], lastLine: {}, lastOutputAt: {}, traces: {} }));

  it('collapses repeated saves of one file into the newest entry', () => {
    const { pushEvent } = useLive.getState();
    pushEvent(fileEvent('a', 'src/x.ts'));
    pushEvent(fileEvent('a', 'src/y.ts'));
    pushEvent(fileEvent('a', 'src/x.ts'));
    pushEvent(fileEvent('b', 'src/x.ts'));
    const feed = useLive.getState().feed;
    expect(feed.map((event) => event.id)).toEqual([`e${next}`, `e${next - 1}`, `e${next - 2}`]);
  });

  it('forgets everything about a closed session', () => {
    useLive.setState({ lastLine: { a: 'hi', b: 'yo' }, lastOutputAt: { a: 1 }, traces: { a: [0] } });
    useLive.getState().forget('a');
    const state = useLive.getState();
    expect(state.lastLine).toEqual({ b: 'yo' });
    expect(state.lastOutputAt).toEqual({});
    expect(state.traces).toEqual({});
  });
});
