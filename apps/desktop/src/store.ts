import { create } from 'zustand';
import type { DiscoverCandidate, SessionRecord } from '@agenterm/core';

interface UiState {
  sessions: SessionRecord[];
  candidates: DiscoverCandidate[];
  selectedId: string | null;
  setSessions: (sessions: SessionRecord[]) => void;
  setCandidates: (candidates: DiscoverCandidate[]) => void;
  select: (id: string | null) => void;
}

/** Local UI state: selected session plus sidebar filters. */
export const useUiState = create<UiState>((set) => ({
  sessions: [],
  candidates: [],
  selectedId: null,
  setSessions: (sessions) => set({ sessions }),
  setCandidates: (candidates) => set({ candidates }),
  select: (selectedId) => set({ selectedId })
}));
