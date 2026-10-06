import type { DiscoverCandidate, SessionRecord } from '@agenterm/core';
import { create } from 'zustand';

/** Confirmations that name exactly what will happen before it happens. */
export type PendingDialog = { kind: 'kill'; session: SessionRecord } | { kind: 'attach'; candidate: DiscoverCandidate };

export type SessionTab = 'terminal' | 'commands' | 'git' | 'files' | 'processes' | 'activity';
export type ThemePreference = 'system' | 'dark' | 'light';

interface Persisted {
  railOpen: boolean;
  theme: ThemePreference;
  acknowledged: string[];
  recentCwds: string[];
}

const STORAGE_KEY = 'agenterm.ui.v1';

function load(): Persisted {
  const fallback: Persisted = { railOpen: true, theme: 'system', acknowledged: [], recentCwds: [] };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null ? fallback : { ...fallback, ...(JSON.parse(raw) as Partial<Persisted>) };
  } catch {
    return fallback;
  }
}

interface UiState extends Persisted {
  selectedId: string | null;
  tab: SessionTab;
  filter: string;
  paletteOpen: boolean;
  newSessionOpen: boolean;
  dialog: PendingDialog | null;
  openDialog: (dialog: PendingDialog | null) => void;
  select: (id: string | null, tab?: SessionTab) => void;
  setTab: (tab: SessionTab) => void;
  setFilter: (filter: string) => void;
  setPaletteOpen: (open: boolean) => void;
  setNewSessionOpen: (open: boolean) => void;
  toggleRail: () => void;
  setTheme: (theme: ThemePreference) => void;
  acknowledge: (key: string) => void;
  rememberCwd: (cwd: string) => void;
}

/** View state. Panel and theme choices plus seen endings persist across launches. */
export const useUi = create<UiState>((set, get) => {
  const persist = (patch: Partial<Persisted>): void => {
    const state = { ...get(), ...patch };
    const snapshot: Persisted = {
      railOpen: state.railOpen,
      theme: state.theme,
      acknowledged: state.acknowledged,
      recentCwds: state.recentCwds
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch {
      // Storage full or disabled; state still applies for this run.
    }
  };
  return {
    ...load(),
    selectedId: null,
    tab: 'terminal',
    filter: '',
    paletteOpen: false,
    newSessionOpen: false,
    dialog: null,
    openDialog: (dialog) => set({ dialog }),
    select: (selectedId, tab) =>
      set((state) => ({ selectedId, tab: tab ?? (selectedId === state.selectedId ? state.tab : 'terminal') })),
    setTab: (tab) => set({ tab }),
    setFilter: (filter) => set({ filter }),
    setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
    setNewSessionOpen: (newSessionOpen) => set({ newSessionOpen }),
    toggleRail: () => {
      const railOpen = !get().railOpen;
      set({ railOpen });
      persist({ railOpen });
    },
    setTheme: (theme) => {
      set({ theme });
      persist({ theme });
    },
    acknowledge: (key) => {
      if (get().acknowledged.includes(key)) return;
      const acknowledged = [...get().acknowledged, key].slice(-500);
      set({ acknowledged });
      persist({ acknowledged });
    },
    rememberCwd: (cwd) => {
      const recentCwds = [cwd, ...get().recentCwds.filter((entry) => entry !== cwd)].slice(0, 8);
      set({ recentCwds });
      persist({ recentCwds });
    }
  };
});
