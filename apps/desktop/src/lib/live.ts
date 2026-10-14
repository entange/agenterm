import type { ActivityResponse } from '@agenterm/core';
import { create } from 'zustand';
import type { ActivityTick, ConnectionInfo } from '../../shared/bridge.js';

interface LiveState {
  connection: ConnectionInfo;
  /** Last visible line of output per task. */
  lastLine: Record<string, string>;
  setConnection: (info: ConnectionInfo) => void;
  seedActivity: (snapshot: ActivityResponse) => void;
  applyTick: (tick: ActivityTick) => void;
  forget: (taskId: string) => void;
}

/** Live state fed by main: the daemon connection and each task's latest output line. */
export const useLive = create<LiveState>((set) => ({
  connection: { state: 'starting', version: null, detail: null },
  lastLine: {},
  setConnection: (connection) => set({ connection }),
  seedActivity: (snapshot) =>
    set((state) => {
      const lastLine = { ...state.lastLine };
      for (const [id, entry] of Object.entries(snapshot.tasks))
        if (entry.lastLine !== null) lastLine[id] = entry.lastLine;
      return { lastLine };
    }),
  applyTick: (tick) =>
    set((state) => {
      let lastLine = state.lastLine;
      for (const [id, sample] of Object.entries(tick.tasks)) {
        if (sample.lastLine === null || lastLine[id] === sample.lastLine) continue;
        if (lastLine === state.lastLine) lastLine = { ...state.lastLine };
        lastLine[id] = sample.lastLine;
      }
      return lastLine === state.lastLine ? state : { lastLine };
    }),
  forget: (taskId) =>
    set((state) => {
      if (!(taskId in state.lastLine)) return state;
      const lastLine = { ...state.lastLine };
      delete lastLine[taskId];
      return { lastLine };
    })
}));
