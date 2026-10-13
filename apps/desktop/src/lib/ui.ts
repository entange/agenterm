import type { DiscoverCandidate, SessionRecord } from '@agenterm/core';
import * as React from 'react';
import { create } from 'zustand';

/** Confirmations that name exactly what will happen before it happens. */
/** Enough for a fleet of ended sessions; older acknowledgements belong to sessions long closed. */
const MAX_ACKNOWLEDGED = 5000;

export type PendingDialog = { kind: 'kill'; session: SessionRecord } | { kind: 'attach'; candidate: DiscoverCandidate };

export type SessionTab = 'terminal' | 'commands' | 'git' | 'files' | 'processes' | 'activity';
export type ThemePreference = 'system' | 'dark' | 'light';
export type GroupBy = 'status' | 'project';
export type Density = 'comfortable' | 'compact';

interface Persisted {
  railOpen: boolean;
  theme: ThemePreference;
  acknowledged: string[];
  recentCwds: string[];
  groupBy: GroupBy;
  density: Density;
  /** Collapsed sidebar groups and parent sessions, by key. */
  collapsed: string[];
}

const STORAGE_KEY = 'agenterm.ui.v1';

/** Below this width the activity rail floats over the main view instead of taking a column. */
const WIDE_QUERY = '(min-width: 1200px)';

function isWide(): boolean {
  return typeof window === 'undefined' || typeof window.matchMedia !== 'function'
    ? true
    : window.matchMedia(WIDE_QUERY).matches;
}

/** Whether the window is wide enough to dock the activity rail. */
export function useWideLayout(): boolean {
  return React.useSyncExternalStore((notify) => {
    if (typeof window.matchMedia !== 'function') return () => undefined;
    const media = window.matchMedia(WIDE_QUERY);
    media.addEventListener('change', notify);
    return () => media.removeEventListener('change', notify);
  }, isWide);
}

function load(): Persisted {
  const fallback: Persisted = {
    railOpen: true,
    theme: 'system',
    acknowledged: [],
    recentCwds: [],
    groupBy: 'status',
    density: 'comfortable',
    collapsed: []
  };
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
  /** The rail opened over the main view in a narrow window; not persisted. */
  railPeek: boolean;
  openDialog: (dialog: PendingDialog | null) => void;
  /** Text the terminal should find once it opens, set by output search. */
  /** Text to open Find on once the session's terminal has loaded its scrollback. */
  pendingFind: { sessionId: string; text: string } | null;
  setPendingFind: (pending: { sessionId: string; text: string } | null) => void;
  select: (id: string | null, tab?: SessionTab) => void;
  setTab: (tab: SessionTab) => void;
  setFilter: (filter: string) => void;
  setPaletteOpen: (open: boolean) => void;
  setNewSessionOpen: (open: boolean) => void;
  toggleRail: () => void;
  setTheme: (theme: ThemePreference) => void;
  acknowledge: (key: string) => void;
  /** Acknowledgement owed for the ended session on screen, paid when the selection moves on. */
  viewingAck: string | null;
  setViewingAck: (key: string | null) => void;
  acknowledgeAll: (keys: string[]) => void;
  rememberCwd: (cwd: string) => void;
  setGroupBy: (groupBy: GroupBy) => void;
  setDensity: (density: Density) => void;
  toggleCollapsed: (key: string) => void;
}

/** View state. Panel and theme choices plus seen endings persist across launches. */
export const useUi = create<UiState>((set, get) => {
  const persist = (patch: Partial<Persisted>): void => {
    const state = { ...get(), ...patch };
    const snapshot: Persisted = {
      railOpen: state.railOpen,
      theme: state.theme,
      acknowledged: state.acknowledged,
      recentCwds: state.recentCwds,
      groupBy: state.groupBy,
      density: state.density,
      collapsed: state.collapsed
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
    railPeek: false,
    openDialog: (dialog) => set({ dialog }),
    pendingFind: null,
    setPendingFind: (pendingFind) => set({ pendingFind }),
    select: (selectedId, tab) => {
      const { viewingAck, selectedId: current } = get();
      if (selectedId !== current && viewingAck !== null) {
        get().acknowledgeAll([viewingAck]);
        set({ viewingAck: null });
      }
      set((state) => ({ selectedId, tab: tab ?? (selectedId === state.selectedId ? state.tab : 'terminal') }));
    },
    viewingAck: null,
    setViewingAck: (viewingAck) => set({ viewingAck }),
    setTab: (tab) => set({ tab }),
    setFilter: (filter) => set({ filter }),
    setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
    setNewSessionOpen: (newSessionOpen) => set({ newSessionOpen }),
    toggleRail: () => {
      if (!isWide()) {
        set({ railPeek: !get().railPeek });
        return;
      }
      const railOpen = !get().railOpen;
      set({ railOpen });
      persist({ railOpen });
    },
    setTheme: (theme) => {
      set({ theme });
      persist({ theme });
    },
    acknowledge: (key) => get().acknowledgeAll([key]),
    acknowledgeAll: (keys) => {
      const current = get().acknowledged;
      const seen = new Set(current);
      const added = keys.filter((key) => !seen.has(key));
      if (added.length === 0) return;
      const acknowledged = [...current, ...added].slice(-MAX_ACKNOWLEDGED);
      set({ acknowledged });
      persist({ acknowledged });
    },
    setGroupBy: (groupBy) => {
      set({ groupBy });
      persist({ groupBy });
    },
    setDensity: (density) => {
      set({ density });
      persist({ density });
    },
    toggleCollapsed: (key) => {
      const current = get().collapsed;
      const collapsed = current.includes(key)
        ? current.filter((entry) => entry !== key)
        : [...current, key].slice(-500);
      set({ collapsed });
      persist({ collapsed });
    },
    rememberCwd: (cwd) => {
      const recentCwds = [cwd, ...get().recentCwds.filter((entry) => entry !== cwd)].slice(0, 8);
      set({ recentCwds });
      persist({ recentCwds });
    }
  };
});
