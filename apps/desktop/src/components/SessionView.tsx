import type { SessionRecord } from '@agenterm/core';
import {
  Button,
  cn,
  IconButton,
  signalBg,
  signalText,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip
} from '@agenterm/ui';
import { Eye, FolderOpen, GitBranch, Octagon, RotateCcw, Square, X } from 'lucide-react';
import * as React from 'react';
import { acknowledgementKey, type Attention } from '../../shared/attention.js';
import { callsign } from '../../shared/callsign.js';
import { useActions } from '../lib/actions.js';
import { getBridge } from '../lib/bridge.js';
import { formatAge, isLive, PROVIDER_NAMES, shortPath } from '../lib/format.js';
import { EMPTY_TRACE, useLive } from '../lib/live.js';
import { useCommands, useFiles, useGit, useProcesses } from '../lib/queries.js';
import { useUi, type SessionTab } from '../lib/ui.js';
import { ActivityTab, CommandsTab, FilesTab, GitTab, ProcessesTab } from './tabs.js';
import { TerminalPane } from './TerminalPane.js';
import { Trace } from './Trace.js';

/** One session: identity and controls on top, the work below in tabs. */
export function SessionView({
  session,
  attention
}: {
  session: SessionRecord;
  attention: Attention | undefined;
}): React.JSX.Element {
  const tab = useUi((state) => state.tab);
  const setTab = useUi((state) => state.setTab);
  const acknowledge = useUi((state) => state.acknowledge);
  const [gitPath, setGitPath] = React.useState<string | null>(null);
  const live = isLive(session);
  const spawned = session.origin === 'spawned';

  // Opening a session that ended badly counts as having seen it.
  React.useEffect(() => {
    if (!live) acknowledge(acknowledgementKey(session));
  }, [acknowledge, live, session]);

  React.useEffect(() => setGitPath(null), [session.id]);

  const commands = useCommands(session.id, spawned);
  const git = useGit(session.id);
  const files = useFiles(session.id);
  const processes = useProcesses(session.id, tab === 'processes' || live);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-canvas">
      <SessionHeader session={session} attention={attention} />
      <Tabs value={tab} onValueChange={(value) => setTab(value as SessionTab)} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="bg-panel">
          <TabsTrigger value="terminal">Terminal</TabsTrigger>
          {spawned ? (
            <TabsTrigger value="commands" badge={commands.data?.length || null}>
              Commands
            </TabsTrigger>
          ) : null}
          <TabsTrigger value="git" badge={git.data?.files.length || null}>
            Changes
          </TabsTrigger>
          <TabsTrigger value="files" badge={files.data?.changes.length || null}>
            Files
          </TabsTrigger>
          <TabsTrigger value="processes" badge={processes.data?.ports.length || null}>
            Processes
          </TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>
        <TabsContent value="terminal" className="min-h-0 flex-1 outline-none data-[state=inactive]:hidden" forceMount>
          {spawned ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="min-h-0 flex-1">
                <TerminalPane key={session.id} session={session} interactive={live} />
              </div>
              {live ? null : <EndedBar session={session} />}
            </div>
          ) : (
            <AttachedPanel session={session} />
          )}
        </TabsContent>
        {spawned ? (
          <TabsContent value="commands" className="min-h-0 flex-1 outline-none">
            <CommandsTab query={commands} />
          </TabsContent>
        ) : null}
        <TabsContent value="git" className="min-h-0 flex-1 outline-none">
          <GitTab session={session} query={git} selected={gitPath} onSelect={setGitPath} />
        </TabsContent>
        <TabsContent value="files" className="min-h-0 flex-1 outline-none">
          <FilesTab
            query={files}
            onOpen={(path) => {
              setGitPath(path);
              setTab('git');
            }}
          />
        </TabsContent>
        <TabsContent value="processes" className="min-h-0 flex-1 outline-none">
          <ProcessesTab session={session} query={processes} />
        </TabsContent>
        <TabsContent value="activity" className="min-h-0 flex-1 outline-none">
          <ActivityTab session={session} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SessionHeader({
  session,
  attention
}: {
  session: SessionRecord;
  attention: Attention | undefined;
}): React.JSX.Element {
  const act = useActions();
  const openDialog = useUi((state) => state.openDialog);
  const samples = useLive((state) => state.traces[session.id]);
  const live = isLive(session);
  const signal = attention?.signal ?? 'idle';
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(session.title);

  React.useEffect(() => {
    setEditing(false);
    setDraft(session.title);
  }, [session.id, session.title]);

  const commitRename = (): void => {
    setEditing(false);
    const next = draft.trim();
    if (next.length > 0 && next !== session.title) void act.rename(session, next);
    else setDraft(session.title);
  };

  return (
    <header className="relative border-b border-line bg-panel px-5 pt-3 pb-2.5">
      <span aria-hidden className={cn('absolute inset-y-0 left-0 w-[3px]', signalBg[signal])} />
      <div className="flex items-center gap-3">
        <span className={cn('callsign text-[12px]', signalText[signal])}>{callsign(session)}</span>
        {editing ? (
          <input
            autoFocus
            value={draft}
            maxLength={200}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitRename();
              if (event.key === 'Escape') {
                setDraft(session.title);
                setEditing(false);
              }
            }}
            aria-label="Session title"
            className="h-7 min-w-0 flex-1 rounded border border-accent bg-raised px-2 text-[15px] font-semibold text-ink focus:outline-none"
          />
        ) : (
          <Tooltip content="Double-click to rename">
            <h1
              tabIndex={0}
              onDoubleClick={() => setEditing(true)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') setEditing(true);
              }}
              className="min-w-0 truncate text-[15px] font-semibold text-ink"
            >
              {session.title}
            </h1>
          </Tooltip>
        )}
        <span
          className={cn(
            'flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11.5px]',
            'border-line',
            signalText[signal]
          )}
        >
          <span
            className={cn(
              'size-1.5 rounded-full',
              signalBg[signal],
              attention?.group === 'needs-you' && 'attn-breathe'
            )}
          />
          {attention?.reason ?? session.lifecycle}
        </span>
        {live && session.origin === 'spawned' ? (
          <Trace samples={samples ?? EMPTY_TRACE} signal={signal} className="ml-1 w-40 shrink" height={20} />
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {live && session.origin === 'spawned' ? (
            <Button
              size="sm"
              tone="quiet"
              onClick={() => void act.interrupt(session)}
              title="Send Ctrl+C to the running program"
            >
              <Octagon className="size-3.5" /> Ctrl+C
            </Button>
          ) : null}
          {!live && session.origin === 'spawned' ? (
            <Button size="sm" tone="secondary" onClick={() => void act.restart(session)}>
              <RotateCcw className="size-3.5" /> Restart
            </Button>
          ) : null}
          {live ? (
            <Button size="sm" tone="danger" onClick={() => openDialog({ kind: 'kill', session })}>
              <Square className="size-3" /> Kill
            </Button>
          ) : null}
          {session.origin === 'attached' && live ? (
            <Button size="sm" tone="quiet" onClick={() => void act.close(session)}>
              <Eye className="size-3.5" /> Detach
            </Button>
          ) : null}
          {!live ? (
            <IconButton label="Close session" onClick={() => void act.close(session)}>
              <X className="size-4" />
            </IconButton>
          ) : null}
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-[1px] text-[12px] text-ink-muted">
        <span>
          {PROVIDER_NAMES[session.provider]}
          {session.origin === 'attached' ? ' · attached read-only' : ''}
        </span>
        {session.branch === null ? null : (
          <span className="flex items-center gap-1">
            <GitBranch className="size-3" /> {session.branch}
          </span>
        )}
        <button
          type="button"
          className="selectable flex max-w-[420px] items-center gap-1 truncate font-mono text-[11.5px] hover:text-ink"
          onClick={() => void getBridge()?.revealPath(session.cwd)}
          title="Open folder"
        >
          <FolderOpen className="size-3 shrink-0" />
          {shortPath(session.cwd)}
        </button>
        <span className="font-mono text-[11.5px]">pid {session.pid}</span>
        <span>
          {live
            ? `started ${formatAge(session.startedAtMs)} ago`
            : `ended ${formatAge(session.endedAtMs ?? session.startedAtMs)} ago`}
        </span>
        <span
          className="selectable truncate font-mono text-[11px] text-ink-faint"
          title={session.commandLine.join(' ')}
        >
          $ {session.commandLine.join(' ')}
        </span>
      </div>
    </header>
  );
}

function EndedBar({ session }: { session: SessionRecord }): React.JSX.Element {
  const act = useActions();
  const outcome =
    session.lifecycle === 'killed'
      ? `Killed${session.exitSignal === null ? '' : ` with ${session.exitSignal}`}`
      : session.lifecycle === 'crashed'
        ? 'Lost when the daemon stopped; this is the saved scrollback'
        : session.exitSignal !== null
          ? `Ended by ${session.exitSignal}`
          : `Exited with code ${session.exitCode ?? '?'}`;
  return (
    <div className="flex items-center gap-3 border-t border-line bg-panel px-4 py-2 text-[12.5px] text-ink-muted">
      <span className="flex-1">
        {outcome} · {formatAge(session.endedAtMs ?? session.startedAtMs)} ago. Output is read-only.
      </span>
      <Button size="sm" tone="secondary" onClick={() => void act.restart(session)}>
        <RotateCcw className="size-3.5" /> Restart
      </Button>
      <Button size="sm" tone="quiet" onClick={() => void act.close(session)}>
        Close
      </Button>
    </div>
  );
}

function AttachedPanel({ session }: { session: SessionRecord }): React.JSX.Element {
  const setTab = useUi((state) => state.setTab);
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md rounded-xl border border-line bg-panel p-6">
        <div className="eyebrow mb-2 text-ink-faint">Attached read-only</div>
        <p className="text-[13.5px] text-ink">
          agenterm is watching pid {session.pid}, but it did not start this process, so there is no terminal to show or
          type into.
        </p>
        <p className="mt-2 text-[12.5px] text-ink-muted">
          Its process tree, open ports, git changes, and file edits are tracked here. Use the terminal you started it in
          to talk to it.
        </p>
        <div className="mt-4 flex gap-2">
          <Button size="sm" tone="secondary" onClick={() => setTab('processes')}>
            Show processes
          </Button>
          <Button size="sm" tone="quiet" onClick={() => setTab('git')}>
            Show changes
          </Button>
        </div>
      </div>
    </div>
  );
}
