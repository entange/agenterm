import type { AgentProvider } from '@agenterm/core';
import { EmptyState, TooltipProvider } from '@agenterm/ui';
import * as React from 'react';
import type { AppCommand } from '../shared/bridge.js';
import { ActivityRail } from './components/ActivityRail.js';
import { ConnectionBanner, TitleBar, Toaster } from './components/chrome.js';
import { CommandPalette } from './components/CommandPalette.js';
import { NewSessionDialog, PendingDialogs } from './components/dialogs.js';
import { Home } from './components/Home.js';
import { Sidebar } from './components/Sidebar.js';
import { buildRows } from './lib/board.js';
import { SessionView } from './components/SessionView.js';
import { getBridge } from './lib/bridge.js';
import { useAttention, useSessions } from './lib/queries.js';
import { useUi, useWideLayout } from './lib/ui.js';
import { useDaemonWiring } from './lib/wiring.js';

/** Apply the theme preference to <html>, following the OS when set to system. */
function useThemeClass(): void {
  const theme = useUi((state) => state.theme);
  React.useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = (): void => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches);
      document.documentElement.classList.toggle('dark', dark);
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
}

export function App(): React.JSX.Element {
  useThemeClass();
  const sessionsQuery = useSessions();
  const sessions = React.useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data]);
  const attention = useAttention(sessions);
  const selectedId = useUi((state) => state.selectedId);
  const railOpen = useUi((state) => state.railOpen);
  const railPeek = useUi((state) => state.railPeek);
  const wide = useWideLayout();
  const newSessionOpen = useUi((state) => state.newSessionOpen);
  const setNewSessionOpen = useUi((state) => state.setNewSessionOpen);
  const [initialProvider, setInitialProvider] = React.useState<AgentProvider | undefined>(undefined);
  const selected = sessions.find((session) => session.id === selectedId) ?? null;

  const openNewSession = React.useCallback(
    (provider?: AgentProvider) => {
      setInitialProvider(provider);
      setNewSessionOpen(true);
    },
    [setNewSessionOpen]
  );

  // Sidebar order (same grouping, nothing collapsed) drives ⌘1-9, cycling, and the palette.
  const groupBy = useUi((state) => state.groupBy);
  const ordered = React.useMemo(
    () =>
      buildRows(sessions, attention, { groupBy, collapsed: new Set(), filter: '', showAllEnded: true }).flatMap(
        (row) => (row.kind === 'session' ? [row.session] : [])
      ),
    [sessions, attention, groupBy]
  );

  const onCommand = (command: AppCommand): void => {
    const ui = useUi.getState();
    switch (command.kind) {
      case 'new-session':
        openNewSession();
        break;
      case 'palette':
        ui.setPaletteOpen(!ui.paletteOpen);
        break;
      case 'toggle-activity':
        ui.toggleRail();
        break;
      case 'home':
        ui.select(null);
        break;
      case 'focus-session':
        ui.select(command.sessionId);
        break;
      case 'jump-session': {
        const target = ordered[command.index];
        if (target !== undefined) ui.select(target.id);
        break;
      }
      case 'cycle-session': {
        if (ordered.length === 0) break;
        const index = ordered.findIndex((session) => session.id === ui.selectedId);
        const next = index === -1 ? 0 : (index + command.delta + ordered.length) % ordered.length;
        const target = ordered[next];
        if (target !== undefined) ui.select(target.id);
        break;
      }
    }
  };
  useDaemonWiring(onCommand);

  // A selected session that was closed elsewhere falls back to the control
  // room, but only once the list has shown it and then lost it.
  const seenIds = React.useRef(new Set<string>());
  React.useEffect(() => {
    for (const session of sessions) seenIds.current.add(session.id);
    if (selectedId !== null && selected === null && seenIds.current.has(selectedId) && !sessionsQuery.isFetching) {
      useUi.getState().select(null);
    }
  }, [sessions, selected, selectedId, sessionsQuery.isFetching]);

  if (getBridge() === null) {
    return (
      <EmptyState
        className="h-full"
        title="agenterm needs its desktop app"
        detail="Open this page from the agenterm app, not a browser."
      />
    );
  }

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col">
        <TitleBar />
        <ConnectionBanner />
        <div className="relative flex min-h-0 flex-1">
          <Sidebar sessions={sessions} attention={attention} onNewSession={() => openNewSession()} />
          <main className="flex min-w-0 flex-1 flex-col">
            {selected === null ? (
              <Home sessions={sessions} attention={attention} onNewSession={openNewSession} />
            ) : (
              <SessionView key={selected.id} session={selected} attention={attention.get(selected.id)} />
            )}
          </main>
          {wide ? (
            railOpen ? (
              <ActivityRail sessions={sessions} />
            ) : null
          ) : railPeek ? (
            <div className="absolute inset-y-0 right-0 z-20 flex shadow-2xl shadow-black/40">
              <ActivityRail sessions={sessions} />
            </div>
          ) : null}
        </div>
      </div>
      <NewSessionDialog
        open={newSessionOpen}
        onOpenChange={setNewSessionOpen}
        sessions={sessions}
        initialProvider={initialProvider}
      />
      <PendingDialogs />
      <CommandPalette sessions={ordered} attention={attention} onNewSession={() => openNewSession()} />
      <Toaster />
    </TooltipProvider>
  );
}
