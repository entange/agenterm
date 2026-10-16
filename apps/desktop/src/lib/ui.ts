import { create } from 'zustand';
import type { GroupBy } from './tasks.js';

export type ThemePreference = 'system' | 'dark' | 'light';

/** The sidebar shows agenterm's tasks, or commands running outside it. */
export type View = 'tasks' | 'outside';

/** A question asked before something that cannot be undone. */
export interface Confirmation {
  title: string;
  detail: string;
  action: string;
  run: () => Promise<void> | void;
}

interface Persisted {
  theme: ThemePreference;
  groupBy: GroupBy;
  /** Collapsed sidebar groups, by key. */
  collapsed: string[];
}

const STORAGE_KEY = 'agenterm.ui.v2';

function load(): Persisted {
  const fallback: Persisted = { theme: 'system', groupBy: 'project', collapsed: [] };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null ? fallback : { ...fallback, ...(JSON.parse(raw) as Partial<Persisted>) };
  } catch {
    return fallback;
  }
}

interface UiState extends Persisted {
  selectedId: string | null;
  view: View;
  /** Selected command outside agenterm, by pid. */
  selectedPid: number | null;
  filter: string;
  paletteOpen: boolean;
  settingsOpen: boolean;
  /** Set when a click asked for the terminal to take the keyboard; the terminal clears it. */
  wantsFocus: boolean;
  confirmation: Confirmation | null;
  select: (id: string | null, options?: { focus?: boolean }) => void;
  setView: (view: View) => void;
  selectPid: (pid: number | null) => void;
  setFilter: (filter: string) => void;
  setPaletteOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  clearFocusRequest: () => void;
  confirm: (confirmation: Confirmation | null) => void;
  setTheme: (theme: ThemePreference) => void;
  setGroupBy: (groupBy: GroupBy) => void;
  toggleCollapsed: (key: string) => void;
}

/** View state. Theme, grouping, and collapsed groups persist across launches. */
export const useUi = create<UiState>((set, get) => {
  const persist = (patch: Partial<Persisted>): void => {
    set(patch);
    const { theme, groupBy, collapsed } = get();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme, groupBy, collapsed }));
    } catch {
      // Storage full or disabled; the choice still applies for this run.
    }
  };
  return {
    ...load(),
    selectedId: null,
    view: 'tasks',
    selectedPid: null,
    filter: '',
    paletteOpen: false,
    settingsOpen: false,
    wantsFocus: false,
    confirmation: null,
    select: (selectedId, options) => set({ selectedId, view: 'tasks', wantsFocus: options?.focus === true }),
    setView: (view) => set({ view }),
    selectPid: (selectedPid) => set({ selectedPid }),
    setFilter: (filter) => set({ filter }),
    setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
    setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
    clearFocusRequest: () => set({ wantsFocus: false }),
    confirm: (confirmation) => set({ confirmation }),
    setTheme: (theme) => persist({ theme }),
    setGroupBy: (groupBy) => persist({ groupBy }),
    toggleCollapsed: (key) => {
      const current = get().collapsed;
      persist({
        collapsed: current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key].slice(-500)
      });
    }
  };
});
