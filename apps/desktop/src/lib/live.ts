import type { ActivityResponse, AgentermEvent, UsageResponse } from '@agenterm/core';
import { create } from 'zustand';
import { WORKING_WINDOW_MS } from '../../shared/attention.js';
import type { ActivityTick, ConnectionInfo } from '../../shared/bridge.js';

/** Heartbeat window: one sample per second for two minutes. */
export const TRACE_SAMPLES = 120;

const FEED_LIMIT = 400;

export const EMPTY_TRACE: number[] = Array.from({ length: TRACE_SAMPLES }, () => 0);

type Spend = { costUsd: number; inputTokens: number; outputTokens: number };

interface LiveState {
  connection: ConnectionInfo;
  /** Output bytes per second, oldest first, TRACE_SAMPLES long. Read per strip, never as a whole. */
  traces: Record<string, number[]>;
  lastLine: Record<string, string>;
  lastOutputAt: Record<string, number>;
  /**
   * Ids with output in the last WORKING_WINDOW_MS, as a sorted string so
   * subscribers re-render only when membership changes, not every second.
   */
  workingKey: string;
  /** Wall clock rounded to 30 s, for "quiet for 5m" style labels. */
  clock: number;
  /** Non-terminal events, newest first. */
  feed: AgentermEvent[];
  /** Model spend per session from agent telemetry. */
  usage: Record<string, Spend>;
  setConnection: (info: ConnectionInfo) => void;
  /** Advance every trace by one second, folding in any daemon activity received since the last step. */
  step: (incoming: ActivityTick['sessions'], atMs: number) => void;
  seedActivity: (snapshot: ActivityResponse) => void;
  seedUsage: (snapshot: UsageResponse) => void;
  pushEvent: (event: AgentermEvent) => void;
  seedFeed: (events: AgentermEvent[]) => void;
  forget: (sessionId: string) => void;
}

function workingKeyOf(lastOutputAt: Record<string, number>, now: number): string {
  return Object.entries(lastOutputAt)
    .filter(([, at]) => now - at <= WORKING_WINDOW_MS)
    .map(([id]) => id)
    .sort()
    .join(',');
}

/**
 * Live state fed by main: connection, per-session output heartbeat, the
 * activity feed, and spend. Built so 500 sessions stay cheap: traces are
 * read per visible strip, and app-wide subscribers watch the working set
 * and a 30-second clock instead of every tick.
 */
export const useLive = create<LiveState>((set) => ({
  connection: { state: 'starting', version: null, detail: null },
  traces: {},
  lastLine: {},
  lastOutputAt: {},
  workingKey: '',
  clock: Math.floor(Date.now() / 30_000) * 30_000,
  feed: [],
  usage: {},
  setConnection: (connection) => set({ connection }),
  step: (incoming, atMs) =>
    set((state) => {
      const traces: Record<string, number[]> = {};
      for (const id of new Set([...Object.keys(state.traces), ...Object.keys(incoming)])) {
        const prior = state.traces[id] ?? EMPTY_TRACE;
        const bytes = incoming[id]?.bytes ?? 0;
        // Idle traces that are already flat stay the same array so their strips do not re-render.
        traces[id] = bytes === 0 && prior.every((value) => value === 0) ? prior : [...prior.slice(1), bytes];
      }
      let lastLine = state.lastLine;
      let lastOutputAt = state.lastOutputAt;
      if (Object.keys(incoming).length > 0) {
        lastLine = { ...state.lastLine };
        lastOutputAt = { ...state.lastOutputAt };
        for (const [id, sample] of Object.entries(incoming)) {
          if (sample.lastLine !== null) lastLine[id] = sample.lastLine;
          if (sample.bytes > 0) lastOutputAt[id] = atMs;
        }
      }
      const workingKey = workingKeyOf(lastOutputAt, atMs);
      const clock = Math.floor(atMs / 30_000) * 30_000;
      return {
        traces,
        lastLine,
        lastOutputAt,
        ...(workingKey === state.workingKey ? {} : { workingKey }),
        ...(clock === state.clock ? {} : { clock })
      };
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
      return { traces, lastLine, lastOutputAt, workingKey: workingKeyOf(lastOutputAt, snapshot.atMs) };
    }),
  seedUsage: (snapshot) =>
    set((state) => {
      const usage = { ...state.usage };
      for (const [id, entry] of Object.entries(snapshot.sessions)) {
        usage[id] = { costUsd: entry.costUsd, inputTokens: entry.inputTokens, outputTokens: entry.outputTokens };
      }
      return { usage };
    }),
  pushEvent: (event) =>
    set((state) => {
      if (event.kind === 'session.usage') {
        return {
          usage: {
            ...state.usage,
            [event.sessionId]: {
              costUsd: event.costUsd,
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens
            }
          }
        };
      }
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
