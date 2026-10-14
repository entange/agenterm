import { isRunning, statusText, type TaskRecord } from '@agenterm/core';
import { SignalDot } from '@agenterm/ui';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useQueryClient } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { Copy, Eraser, Moon, Power, Settings, Skull, Square, SunMoon, Trash2 } from 'lucide-react';
import * as React from 'react';
import { taskLabel } from '../../shared/label.js';
import { clearEnded, copyText, removeTask, stopTask } from '../lib/actions.js';
import { getBridge } from '../lib/bridge.js';
import { shortPath, signalOf } from '../lib/format.js';
import { useUi } from '../lib/ui.js';

const itemClass =
  'flex h-9 cursor-default items-center gap-2.5 rounded-md px-2.5 text-[13px] text-ink data-[selected=true]:bg-accent-soft data-[selected=true]:text-ink';

const groupClass =
  '[&_[cmdk-group-heading]]:eyebrow [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-ink-faint';

/** ⌘K: jump to any task by id, title, command, or folder, or run an action by name. */
export function CommandPalette({ tasks }: { tasks: TaskRecord[] }): React.JSX.Element {
  const client = useQueryClient();
  const open = useUi((state) => state.paletteOpen);
  const setOpen = useUi((state) => state.setPaletteOpen);
  const select = useUi((state) => state.select);
  const selectedId = useUi((state) => state.selectedId);
  const theme = useUi((state) => state.theme);
  const setTheme = useUi((state) => state.setTheme);
  const selected = tasks.find((task) => task.id === selectedId);

  const run = (action: () => void): void => {
    setOpen(false);
    action();
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/35" />
        <DialogPrimitive.Content className="fixed top-[12vh] left-1/2 z-50 w-[min(600px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-xl border border-line-strong bg-panel shadow-2xl">
          <DialogPrimitive.Title className="sr-only">Find a task</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">Jump to a task or run an action</DialogPrimitive.Description>
          <Command label="Find a task" loop>
            <Command.Input
              autoFocus
              placeholder="Jump to a task or run an action…"
              className="h-12 w-full border-b border-line bg-transparent px-4 text-[14px] text-ink placeholder:text-ink-faint outline-none focus-visible:outline-none"
            />
            <Command.List className="scroll-thin max-h-[380px] overflow-y-auto p-2">
              <Command.Empty className="px-3 py-6 text-center text-[12.5px] text-ink-muted">No matches.</Command.Empty>
              {tasks.length > 0 ? (
                <Command.Group heading="Tasks" className={groupClass}>
                  {tasks.map((task) => (
                    <Command.Item
                      key={task.id}
                      value={`${task.id} ${task.title} ${task.command} ${task.cwd} ${task.startedBy ?? ''}`}
                      onSelect={() => run(() => select(task.id, { focus: true }))}
                      className={itemClass}
                    >
                      <SignalDot signal={signalOf(task)} />
                      <span className="min-w-0 flex-1 truncate">{taskLabel(task)}</span>
                      <span className="min-w-0 flex-[2] truncate font-mono text-[11.5px] text-ink-faint">
                        {task.command}
                      </span>
                      <span className="shrink-0 truncate text-[11.5px] text-ink-faint">
                        {isRunning(task) ? shortPath(task.cwd) : statusText(task)}
                      </span>
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}
              <Command.Group heading="Actions" className={groupClass}>
                {selected !== undefined && isRunning(selected) ? (
                  <>
                    <Command.Item
                      value={`stop ${selected.id}`}
                      onSelect={() => run(() => void stopTask(client, selected, false))}
                      className={itemClass}
                    >
                      <Square className="size-3.5 text-ink-faint" /> Stop {selected.id}
                    </Command.Item>
                    <Command.Item
                      value={`kill ${selected.id}`}
                      onSelect={() => run(() => void stopTask(client, selected, true))}
                      className={itemClass}
                    >
                      <Skull className="size-3.5 text-fail" /> Kill {selected.id}
                    </Command.Item>
                  </>
                ) : null}
                {selected !== undefined ? (
                  <>
                    <Command.Item
                      value={`remove delete ${selected.id}`}
                      onSelect={() => run(() => removeTask(client, selected))}
                      className={itemClass}
                    >
                      <Trash2 className="size-3.5 text-ink-faint" /> Remove {selected.id}
                    </Command.Item>
                    <Command.Item
                      value={`copy id ${selected.id}`}
                      onSelect={() => run(() => copyText(selected.id, 'task id'))}
                      className={itemClass}
                    >
                      <Copy className="size-3.5 text-ink-faint" /> Copy id {selected.id}
                    </Command.Item>
                  </>
                ) : null}
                <Command.Item
                  value="clear ended finished stopped failed tasks"
                  onSelect={() => run(() => void clearEnded(client))}
                  className={itemClass}
                >
                  <Eraser className="size-3.5 text-ink-faint" /> Clear ended tasks
                </Command.Item>
                <Command.Item
                  value="settings preferences stop with agent notifications"
                  onSelect={() => run(() => useUi.getState().setSettingsOpen(true))}
                  className={itemClass}
                >
                  <Settings className="size-3.5 text-ink-faint" /> Settings
                </Command.Item>
                <Command.Item
                  value="theme appearance dark light system"
                  onSelect={() =>
                    run(() => setTheme(theme === 'system' ? 'dark' : theme === 'dark' ? 'light' : 'system'))
                  }
                  className={itemClass}
                >
                  {theme === 'dark' ? (
                    <Moon className="size-3.5 text-ink-faint" />
                  ) : (
                    <SunMoon className="size-3.5 text-ink-faint" />
                  )}
                  Theme: {theme} (switch)
                </Command.Item>
                <Command.Item
                  value="stop daemon shutdown"
                  onSelect={() => run(() => void getBridge()?.stopDaemon())}
                  className={itemClass}
                >
                  <Power className="size-3.5 text-ink-faint" /> Stop daemon…
                </Command.Item>
              </Command.Group>
            </Command.List>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
