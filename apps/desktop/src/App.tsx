import { isRunning } from '@agenterm/core';
import { EmptyState, TooltipProvider } from '@agenterm/ui';
import * as React from 'react';
import type { AppCommand } from '../shared/bridge.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { ConnectionBanner, TasksErrorBanner, TitleBar, Toaster } from './components/chrome.js';
import { CommandPalette } from './components/CommandPalette.js';
import { ConfirmDialog, SettingsDialog } from './components/dialogs.js';
import { OutsideEmpty, OutsideView } from './components/Outside.js';
import { Sidebar } from './components/Sidebar.js';
import { TaskView, Welcome } from './components/TaskView.js';
import { getBridge } from './lib/bridge.js';
import { useLive } from './lib/live.js';
import { useOutside, useTasks } from './lib/queries.js';
import { buildRows, taskOrder } from './lib/tasks.js';
import { useUi } from './lib/ui.js';
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
  const tasksQuery = useTasks();
  const tasks = React.useMemo(() => tasksQuery.data ?? [], [tasksQuery.data]);
  const online = useLive((state) => state.connection.state === 'online');
  const selectedId = useUi((state) => state.selectedId);
  const groupBy = useUi((state) => state.groupBy);
  const filter = useUi((state) => state.filter);
  const collapsed = useUi((state) => state.collapsed);
  const selected = tasks.find((task) => task.id === selectedId) ?? null;
  const view = useUi((state) => state.view);
  const outsideQuery = useOutside(view === 'outside');
  const outside = React.useMemo(() => outsideQuery.data ?? [], [outsideQuery.data]);
  const selectedPid = useUi((state) => state.selectedPid);
  const picked = outside.find((entry) => entry.pid === selectedPid) ?? null;

  const rows = React.useMemo(
    () => buildRows(tasks, { groupBy, filter, collapsed: new Set(collapsed) }),
    [tasks, groupBy, filter, collapsed]
  );
  // ⌘1-9 and next/previous follow the rows the sidebar shows.
  const visible = React.useMemo(() => taskOrder(rows), [rows]);
  // The palette lists every task, in sidebar order where possible.
  const ordered = React.useMemo(
    () => taskOrder(buildRows(tasks, { groupBy, filter: '', collapsed: new Set() })),
    [tasks, groupBy]
  );

  const onCommand = (command: AppCommand): void => {
    const ui = useUi.getState();
    switch (command.kind) {
      case 'palette':
        ui.setPaletteOpen(!ui.paletteOpen);
        break;
      case 'settings':
        ui.setSettingsOpen(true);
        break;
      case 'focus-task':
        ui.select(command.taskId, { focus: true });
        break;
      case 'show-outside':
        ui.setView('outside');
        if (command.pid !== null) ui.selectPid(command.pid);
        break;
      case 'jump-task': {
        const target = visible[command.index];
        if (target !== undefined) ui.select(target.id, { focus: true });
        break;
      }
      case 'cycle-task': {
        if (visible.length === 0) break;
        const index = visible.findIndex((task) => task.id === ui.selectedId);
        const next = index === -1 ? 0 : (index + command.delta + visible.length) % visible.length;
        const target = visible[next];
        if (target !== undefined) ui.select(target.id, { focus: true });
        break;
      }
    }
  };
  useDaemonWiring(onCommand);

  // Always show a terminal when there is one: with nothing selected, open the
  // newest running task. When the selected task is removed, move to the task
  // that took its place in the list.
  const previousOrder = React.useRef<string[]>([]);
  const seenIds = React.useRef(new Set<string>());
  React.useEffect(() => {
    for (const task of tasks) seenIds.current.add(task.id);
    const ids = visible.map((task) => task.id);
    const lost = selectedId !== null && selected === null && seenIds.current.has(selectedId);
    if (selectedId === null || lost) {
      let next = visible.find(isRunning) ?? visible[0];
      if (lost) {
        const at = previousOrder.current.indexOf(selectedId);
        const neighbor = previousOrder.current.slice(at + 1).find((id) => ids.includes(id));
        next = visible.find((task) => task.id === neighbor) ?? visible[visible.length - 1];
      }
      if (next !== undefined || lost) useUi.getState().select(next?.id ?? null);
    }
    previousOrder.current = ids;
  }, [tasks, visible, selected, selectedId]);

  // Outside agenterm: keep something picked, the first orphan when there is one.
  React.useEffect(() => {
    if (view !== 'outside' || picked !== null) return;
    const first =
      outside.find((entry) => entry.orphaned && !entry.hidden) ?? outside.find((entry) => !entry.hidden) ?? outside[0];
    if (first !== undefined) useUi.getState().selectPid(first.pid);
  }, [view, picked, outside]);

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
        {online && tasksQuery.isError ? (
          <TasksErrorBanner error={tasksQuery.error} retry={() => void tasksQuery.refetch()} />
        ) : null}
        <div className="relative flex min-h-0 flex-1">
          <Sidebar rows={rows} tasks={tasks} outside={outside} outsideLoading={outsideQuery.isPending} />
          <main className="flex min-w-0 flex-1 flex-col bg-term">
            {view === 'outside' ? (
              picked === null ? (
                <OutsideEmpty count={outside.length} />
              ) : (
                <ErrorBoundary key={picked.pid} title="This command's view hit an error">
                  <OutsideView entry={picked} />
                </ErrorBoundary>
              )
            ) : selected === null ? (
              <Welcome hasTasks={tasks.length > 0} />
            ) : (
              <ErrorBoundary key={selected.id} title="This task's view hit an error">
                <TaskView task={selected} />
              </ErrorBoundary>
            )}
          </main>
        </div>
      </div>
      <CommandPalette tasks={ordered} />
      <SettingsDialog />
      <ConfirmDialog />
      <Toaster />
    </TooltipProvider>
  );
}
