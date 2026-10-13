import type { SessionRecord } from '@agenterm/core';
import { Kbd } from '@agenterm/ui';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Command } from 'cmdk';
import { Activity, LayoutGrid, Moon, Plus, Power, Square, SunMoon, TerminalSquare } from 'lucide-react';
import * as React from 'react';
import type { Attention } from '../../shared/attention.js';
import { callsign } from '../../shared/callsign.js';
import { api, getBridge } from '../lib/bridge.js';
import { isLive, shortPath } from '../lib/format.js';
import { useUi } from '../lib/ui.js';
import { shortcut } from '../lib/shortcuts.js';

const itemClass =
  'flex h-9 cursor-default items-center gap-2.5 rounded-md px-2.5 text-[13px] text-ink data-[selected=true]:bg-accent-soft data-[selected=true]:text-ink';

/** ⌘K: jump to any session or run any action by name. */
export function CommandPalette({
  sessions,
  attention,
  onNewSession
}: {
  sessions: SessionRecord[];
  attention: Map<string, Attention>;
  onNewSession: () => void;
}): React.JSX.Element {
  const open = useUi((state) => state.paletteOpen);
  const setOpen = useUi((state) => state.setPaletteOpen);
  const select = useUi((state) => state.select);
  const selectedId = useUi((state) => state.selectedId);
  const theme = useUi((state) => state.theme);
  const setTheme = useUi((state) => state.setTheme);
  const toggleRail = useUi((state) => state.toggleRail);
  const openDialog = useUi((state) => state.openDialog);
  const selected = sessions.find((session) => session.id === selectedId);
  const setPendingFind = useUi((state) => state.setPendingFind);
  const [query, setQuery] = React.useState('');
  const [hits, setHits] = React.useState<Array<{ sessionId: string; line: number; text: string }>>([]);

  // Each opening starts clean.
  React.useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  // Output search runs alongside the session and action filter, debounced.
  React.useEffect(() => {
    const text = query.trim();
    if (!open || text.length < 3) {
      setHits([]);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void api('search', text, { limit: 30 })
        .then((result) => {
          if (!cancelled) setHits(result.matches);
        })
        .catch(() => undefined);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, open]);
  const byId = new Map(sessions.map((session) => [session.id, session]));

  const run = (action: () => void): void => {
    setOpen(false);
    action();
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/35" />
        <DialogPrimitive.Content className="fixed top-[12vh] left-1/2 z-50 w-[min(600px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-xl border border-line-strong bg-panel shadow-2xl">
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Jump to a session or run an action
          </DialogPrimitive.Description>
          <Command label="Command palette" loop>
            <Command.Input
              value={query}
              onValueChange={setQuery}
              autoFocus
              placeholder="Jump to a session or run an action…"
              className="h-12 w-full border-b border-line bg-transparent px-4 text-[14px] text-ink placeholder:text-ink-faint outline-none focus-visible:outline-none"
            />
            <Command.List className="scroll-thin max-h-[380px] overflow-y-auto p-2">
              <Command.Empty className="px-3 py-6 text-center text-[12.5px] text-ink-muted">No matches.</Command.Empty>
              {sessions.length > 0 ? (
                <Command.Group
                  heading="Sessions"
                  className="[&_[cmdk-group-heading]]:eyebrow [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-ink-faint"
                >
                  {sessions.map((session) => (
                    <Command.Item
                      key={session.id}
                      value={`${callsign(session)} ${session.title} ${session.cwd} ${session.branch ?? ''}`}
                      onSelect={() => run(() => select(session.id))}
                      className={itemClass}
                    >
                      <TerminalSquare className="size-3.5 text-ink-faint" />
                      <span className="callsign w-20 text-[10.5px] text-ink-faint">{callsign(session)}</span>
                      <span className="min-w-0 flex-1 truncate">{session.title}</span>
                      <span className="truncate text-[11.5px] text-ink-faint">
                        {attention.get(session.id)?.reason ?? shortPath(session.cwd)}
                      </span>
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}
              {hits.length > 0 ? (
                <Command.Group
                  heading="In terminal output"
                  className="[&_[cmdk-group-heading]]:eyebrow [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-ink-faint"
                >
                  {hits.map((hit) => {
                    const session = byId.get(hit.sessionId);
                    return (
                      <Command.Item
                        key={`${hit.sessionId}:${hit.line}`}
                        value={`${query} output ${hit.sessionId} ${hit.line} ${hit.text}`}
                        onSelect={() =>
                          run(() => {
                            setPendingFind({ sessionId: hit.sessionId, text: query.trim() });
                            select(hit.sessionId, 'terminal');
                          })
                        }
                        className={itemClass}
                      >
                        <span className="callsign w-20 shrink-0 text-[10.5px] text-ink-faint">
                          {session === undefined ? hit.sessionId.slice(0, 8) : callsign(session)}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{hit.text}</span>
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              ) : null}
              <Command.Group
                heading="Actions"
                className="[&_[cmdk-group-heading]]:eyebrow [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-ink-faint"
              >
                <Command.Item value="new session start agent" onSelect={() => run(onNewSession)} className={itemClass}>
                  <Plus className="size-3.5 text-ink-faint" /> New session{' '}
                  <Kbd className="ml-auto">{shortcut('N')}</Kbd>
                </Command.Item>
                <Command.Item
                  value="control room home overview"
                  onSelect={() => run(() => select(null))}
                  className={itemClass}
                >
                  <LayoutGrid className="size-3.5 text-ink-faint" /> Go to control room{' '}
                  <Kbd className="ml-auto">{shortcut('H', { shift: true })}</Kbd>
                </Command.Item>
                <Command.Item value="toggle activity rail feed" onSelect={() => run(toggleRail)} className={itemClass}>
                  <Activity className="size-3.5 text-ink-faint" /> Show or hide activity{' '}
                  <Kbd className="ml-auto">{shortcut('J')}</Kbd>
                </Command.Item>
                {selected !== undefined && isLive(selected) ? (
                  <Command.Item
                    value={`kill ${callsign(selected)}`}
                    onSelect={() => run(() => openDialog({ kind: 'kill', session: selected }))}
                    className={itemClass}
                  >
                    <Square className="size-3 text-fail" /> Kill {callsign(selected)}…
                  </Command.Item>
                ) : null}
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
