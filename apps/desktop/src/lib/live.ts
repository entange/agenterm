import type { ActivityResponse, AgentermEvent } from '@agenterm/core';
import { create } from 'zustand';
import type { ActivityTick, ConnectionInfo } from '../../shared/bridge.js';

/** Heartbeat window: one sample per second for two minutes. */
export const TRACE_SAMPLES = 120;

const FEED_LIMIT = 400;

interface LiveState {
  connection: ConnectionInfo;
  /** Output bytes per second, oldest first, TRACE_SAMPLES long. */
  traces: Record<string, number[]>;
  lastLine: Record<string, string>;
  lastOutputAt: Record<string, number>;
  /** Non-terminal events, newest first. */
  feed: AgentermEvent[];
  setConnection: (info: ConnectionInfo) => void;
  applyTick: (tick: ActivityTick) => void;
  /** Replace traces with the daemon's recorded window, e.g. after connecting. */
  seedActivity: (snapshot: ActivityResponse) => void;
  pushEvent: (event: AgentermEvent) => void;
  seedFeed: (events: AgentermEvent[]) => void;
  forget: (sessionId: string) => void;
}

export const EMPTY_TRACE: number[] = Array.from({ length: TRACE_SAMPLES }, () => 0);

/**
 * Live state fed by main: connection, per-session output heartbeat, and
 * the activity feed. Every tick advances every known trace by one sample
 * so idle sessions visibly flatline.
 */
export const useLive = create<LiveState>((set) => ({
  connection: { state: 'starting', version: null, detail: null },
  traces: {},
  lastLine: {},
  lastOutputAt: {},
  feed: [],
  setConnection: (connection) => set({ connection }),
  applyTick: (tick) =>
    set((state) => {
      const traces: Record<string, number[]> = {};
      const ids = new Set([...Object.keys(state.traces), ...Object.keys(tick.sessions)]);
      const lastLine = { ...state.lastLine };
      const lastOutputAt = { ...state.lastOutputAt };
      for (const id of ids) {
        const sample = tick.sessions[id];
        const prior = state.traces[id] ?? EMPTY_TRACE;
        traces[id] = [...prior.slice(1), sample?.bytes ?? 0];
        if (sample !== undefined) {
          if (sample.lastLine !== null) lastLine[id] = sample.lastLine;
          if (sample.bytes > 0) lastOutputAt[id] = tick.atMs;
        }
      }
      return { traces, lastLine, lastOutputAt };
    }),
  seedActivity: (snapshot) =>
    set((state) => {
      const traces = { ...state.traces };
      const lastLine = { ...state.lastLine };
      const lastOutputAt = { ...state.lastOutputAt };
      for (const [id, entry] of Object.entries(snapshot.sessions)) {
        traces[id] = entry.samples.slice(-TRACE_SAMPLES);
        if (entry.lastLine !== null) lastLine[id] = entry.lastLine;
        if (entry.lastOutputAtMs !== null) lastOutputAt[id] = entry.lastOutputAtMs;
      }
      return { traces, lastLine, lastOutputAt };
    }),
  pushEvent: (event) =>
    set((state) => {
      if (event.kind === 'terminal.output' || event.kind === 'terminal.input') return state;
      if (state.feed.some((entry) => entry.id === event.id)) return state;
      return { feed: [event, ...state.feed].slice(0, FEED_LIMIT) };
    }),
  seedFeed: (events) =>
    set((state) => {
      const seen = new Set(state.feed.map((event) => event.id));
      const merged = [...state.feed, ...events.filter((event) => !seen.has(event.id))];
      merged.sort((a, b) => b.createdAtMs - a.createdAtMs);
      return { feed: merged.slice(0, FEED_LIMIT) };
    }),
  forget: (sessionId) =>
    set((state) => {
      const traces = { ...state.traces };
      delete traces[sessionId];
      return { traces };
    })
}));
