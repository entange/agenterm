import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentProvider } from '@agenterm/core';
import { Button, EmptyState } from '@agenterm/ui';
import { useUiState } from './store.js';
import { getBridge } from './daemon.js';
import { XTermView } from './xterm.js';

const PROVIDERS: AgentProvider[] = ['claude', 'codex', 'gemini', 'opencode', 'generic'];

/** Dashboard: what is running, what needs attention, what is happening. */
export function App(): React.JSX.Element {
  const { sessions, selectedId, select, setSessions, setCandidates } = useUiState();
  const queryClient = useQueryClient();
  const [showSpawn, setShowSpawn] = useState(false);
  const [tab, setTab] = useState<'terminal' | 'processes' | 'ports' | 'commands'>('terminal');
  const [provider, setProvider] = useState<AgentProvider>('claude');
  const [command, setCommand] = useState('');
  const [cwd, setCwd] = useState('');
  const [title, setTitle] = useState('');

  const health = useQuery({
    queryKey: ['health'],
    queryFn: async () => getBridge()?.health() ?? { ok: false as const }
  });

  const sessionsQuery = useQuery({
    queryKey: ['sessions'],
    refetchInterval: 3000,
    queryFn: async () => {
      const bridge = getBridge();
      if (bridge === null) return;
      const out = await bridge.listSessions();
      setSessions(out.sessions);
    }
  });

  const discoverQuery = useQuery({
    queryKey: ['discover'],
    refetchInterval: 8000,
    queryFn: async () => {
      const bridge = getBridge();
      if (bridge === null) return;
      const out = await bridge.discover();
      setCandidates(out.candidates);
    }
  });

  useEffect(() => {
    const bridge = getBridge();
    if (bridge === null) return;
    return bridge.onEvent((event) => {
      if (event.kind.startsWith('session.') || event.kind.startsWith('workspace.')) {
        void queryClient.invalidateQueries({ queryKey: ['sessions'] });
        void queryClient.invalidateQueries({ queryKey: ['detail'] });
      }
      if (event.kind.startsWith('port.')) {
        void queryClient.invalidateQueries({ queryKey: ['detail'] });
      }
    });
  }, [queryClient]);

  const selected = sessions.find((entry) => entry.id === selectedId) ?? null;

  const detail = useQuery({
    queryKey: ['detail', selectedId],
    enabled: selectedId !== null,
    refetchInterval: 3000,
    queryFn: async () => {
      const bridge = getBridge();
      if (bridge === null || selectedId === null) return null;
      return bridge.detail(selectedId);
    }
  });

  const commandsQuery = useQuery({
    queryKey: ['commands', selectedId, tab],
    enabled: selectedId !== null && tab === 'commands',
    refetchInterval: 3000,
    queryFn: async () => {
      const bridge = getBridge();
      if (bridge === null || selectedId === null) return null;
      return bridge.commands(selectedId);
    }
  });

  const refresh = (): void => {
    void sessionsQuery.refetch();
    void discoverQuery.refetch();
    void detail.refetch();
  };

  const spawnSession = async (): Promise<void> => {
    const bridge = getBridge();
    if (bridge === null) return;
    const body: Record<string, unknown> = { provider, cwd, args: [], env: {} };
    if (command.trim().length > 0) body['command'] = command.trim();
    if (title.trim().length > 0) body['title'] = title.trim();
    const out = await bridge.spawn(body);
    setShowSpawn(false);
    setCommand('');
    setTitle('');
    select(out.session.id);
    refresh();
  };

  const attachPid = async (pid: number): Promise<void> => {
    const bridge = getBridge();
    if (bridge === null) return;
    const out = await bridge.attach({ pid });
    select(out.session.id);
    refresh();
  };

  const endSelected = async (killTree: boolean): Promise<void> => {
    const bridge = getBridge();
    if (bridge === null || selected === null) return;
    await bridge.endSession(selected.id, killTree);
    select(null);
    refresh();
  };

  const sendCtrlC = async (): Promise<void> => {
    const bridge = getBridge();
    if (bridge === null || selected === null) return;
    await bridge.input(selected.id, '\x03').catch(() => undefined);
  };

  const cwdClash = cwd.trim().length > 0 && sessions.some((entry) => entry.cwd === cwd.trim());

  return (
    <div className="flex h-screen bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <aside className="w-80 shrink-0 overflow-y-auto border-r border-zinc-200 p-4 dark:border-zinc-800">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-bold">agenterm</h1>
          <Button tone="primary" className="h-7 text-xs" onClick={() => setShowSpawn(true)}>
            New session
          </Button>
        </div>
        <p className="mt-1 text-xs text-zinc-500">
          Daemon: {health.data === undefined ? 'checking' : 'reachable'}
        </p>
        <div className="mt-4 space-y-2">
          {sessions.length === 0 ? (
            <EmptyState title="No sessions" detail="Spawn a session or attach a running agent PID." />
          ) : (
            sessions.map((entry) => (
              <button
                key={entry.id}
                onClick={() => {
                  select(entry.id);
                  setTab('terminal');
                }}
                className="w-full rounded-md border border-zinc-200 p-2 text-left hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
              >
                <div className="text-sm font-semibold">{entry.title}</div>
                <div className="text-xs text-zinc-500">
                  {entry.origin} {entry.lifecycle} pid={entry.pid}
                </div>
              </button>
            ))
          )}
        </div>
        <div className="mt-6 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Discover</h2>
          <Button tone="quiet" className="h-6 px-2 text-xs" onClick={() => void discoverQuery.refetch()}>
            Rescan
          </Button>
        </div>
        <div className="mt-2 space-y-2">
          {useUiState.getState().candidates.map((entry) => (
            <div key={entry.pid} className="rounded-md border border-zinc-200 p-2 text-xs dark:border-zinc-800">
              <div className="font-semibold">
                {entry.pid} {entry.binaryName}
              </div>
              <div className="truncate text-zinc-500">{entry.commandLine}</div>
              <Button tone="quiet" className="mt-1 h-6 px-2 text-xs" onClick={() => void attachPid(entry.pid)}>
                Attach
              </Button>
            </div>
          ))}
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto p-4">
        {selected === null ? (
          <EmptyState title="Select a session" detail="Choose a session on the left to see the live terminal." />
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-bold">{selected.title}</h2>
              <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-xs dark:bg-zinc-800">
                {selected.lifecycle}
              </span>
              <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-xs dark:bg-zinc-800">{selected.origin}</span>
              {selected.overlay !== 'unknown' && (
                <span className="rounded-full bg-sky-200 px-2 py-0.5 text-xs dark:bg-sky-900">
                  {selected.overlay}
                </span>
              )}
              <span className="ml-auto flex gap-2">
                {selected.origin === 'spawned' && selected.lifecycle === 'running' && (
                  <Button tone="quiet" className="h-7 text-xs" onClick={() => void sendCtrlC()}>
                    Ctrl+C
                  </Button>
                )}
                <Button tone="danger" className="h-7 text-xs" onClick={() => void endSelected(true)}>
                  Kill tree
                </Button>
                {selected.origin === 'attached' && (
                  <Button tone="quiet" className="h-7 text-xs" onClick={() => void endSelected(false)}>
                    Detach
                  </Button>
                )}
              </span>
            </div>
            <div className="text-xs text-zinc-500">
              {selected.provider} pid={selected.pid} cwd={selected.cwd} branch={selected.branch ?? '-'}
            </div>
            <div className="flex gap-2 text-xs">
              {(['terminal', 'processes', 'ports', 'commands'] as const).map((name) => (
                <button
                  key={name}
                  onClick={() => setTab(name)}
                  className={`rounded-md px-2 py-1 font-semibold capitalize ${
                    tab === name ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900' : 'bg-zinc-100 dark:bg-zinc-800'
                  }`}
                >
                  {name}
                </button>
              ))}
            </div>
            {tab === 'terminal' && (
              <div className="space-y-2">
                {selected.origin === 'attached' && (
                  <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs dark:border-amber-800 dark:bg-amber-950">
                    Read-only: attached sessions expose the process tree with no PTY takeover.
                  </div>
                )}
                <XTermView sessionId={selected.id} readOnly={selected.origin === 'attached'} />
              </div>
            )}
            {tab === 'processes' && (
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="text-zinc-500">
                    <th className="py-1">pid</th>
                    <th>ppid</th>
                    <th>command</th>
                    <th>cpu</th>
                    <th>rss</th>
                  </tr>
                </thead>
                <tbody>
                  {(detail.data?.processes ?? []).map((row) => (
                    <tr key={row.pid} className="border-t border-zinc-200 dark:border-zinc-800">
                      <td className="py-1 font-mono">{row.pid}</td>
                      <td className="font-mono">{row.ppid}</td>
                      <td className="max-w-md truncate">{row.command}</td>
                      <td>{row.cpuPercent ?? '-'}</td>
                      <td>{row.rssBytes ?? '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {tab === 'ports' && (
              <div className="space-y-2 text-xs">
                {(detail.data?.ports ?? []).length === 0 && (
                  <EmptyState title="No ports" detail="Listening sockets owned by this session appear here." />
                )}
                {(detail.data?.ports ?? []).map((port) => (
                  <div
                    key={`${port.port}:${port.pid}`}
                    className="flex items-center gap-2 rounded-md border border-zinc-200 p-2 dark:border-zinc-800"
                  >
                    <span className="font-mono font-semibold">:{port.port}</span>
                    <span className="text-zinc-500">pid={port.pid}</span>
                    <a
                      className="ml-auto text-sky-600 underline"
                      href={`http://localhost:${port.port}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open
                    </a>
                  </div>
                ))}
              </div>
            )}
            {tab === 'commands' && (
              <div className="space-y-2 text-xs">
                {(commandsQuery.data?.commands ?? []).length === 0 && (
                  <EmptyState title="No commands" detail="Prompt-anchored commands appear here as the session runs." />
                )}
                {(commandsQuery.data?.commands ?? []).map((row) => (
                  <div
                    key={row.id}
                    className="rounded-md border border-zinc-200 p-2 dark:border-zinc-800"
                  >
                    <div className="truncate font-mono font-semibold">{row.text}</div>
                    <div className="mt-1 text-zinc-500">
                      {row.durationMs === null ? 'running' : `${row.durationMs}ms`} ·{' '}
                      {row.outputLineCount ?? 0} lines · exit {row.exitCode ?? 'unknown'}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>
      {showSpawn && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/40">
          <div className="w-96 space-y-3 rounded-lg bg-white p-4 dark:bg-zinc-900">
            <h2 className="text-sm font-bold">New session</h2>
            <label className="block text-xs">
              Provider
              <select
                className="mt-1 w-full rounded-md border border-zinc-300 p-1 dark:border-zinc-700 dark:bg-zinc-800"
                value={provider}
                onChange={(e) => setProvider(e.target.value as AgentProvider)}
              >
                {PROVIDERS.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs">
              Command override (generic requires one)
              <input
                className="mt-1 w-full rounded-md border border-zinc-300 p-1 dark:border-zinc-700 dark:bg-zinc-800"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="claude"
              />
            </label>
            <label className="block text-xs">
              Working directory
              <input
                className="mt-1 w-full rounded-md border border-zinc-300 p-1 dark:border-zinc-700 dark:bg-zinc-800"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="/absolute/path"
              />
            </label>
            {cwdClash && (
              <p className="text-xs text-amber-600">Warning: another session already uses this cwd.</p>
            )}
            <label className="block text-xs">
              Title
              <input
                className="mt-1 w-full rounded-md border border-zinc-300 p-1 dark:border-zinc-700 dark:bg-zinc-800"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Optional human title"
              />
            </label>
            <div className="flex justify-end gap-2">
              <Button tone="quiet" onClick={() => setShowSpawn(false)}>
                Cancel
              </Button>
              <Button
                tone="primary"
                onClick={() => void spawnSession().catch(() => undefined)}
              >
                Spawn
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
