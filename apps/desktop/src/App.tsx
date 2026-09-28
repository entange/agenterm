import { useQuery } from '@tanstack/react-query';
import { Button, EmptyState } from '@agenterm/ui';
import { useUiState } from './store.js';
import { XTermView } from './xterm.js';

/** Dashboard: what is running, what needs attention, what is happening. */
export function App(): React.JSX.Element {
  const { sessions, candidates, selectedId, select } = useUiState();

  const health = useQuery({
    queryKey: ['health'],
    queryFn: async () => {
      const bridge = (window as unknown as { agenterm?: { health: () => Promise<unknown> } }).agenterm;
      if (bridge === undefined) return { ok: false as const };
      return (await bridge.health()) as unknown;
    }
  });

  const selected = sessions.find((entry) => entry.id === selectedId) ?? null;

  return (
    <div className="flex h-screen bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <aside className="w-80 border-r border-zinc-200 p-4 dark:border-zinc-800">
        <h1 className="text-lg font-bold">agenterm</h1>
        <p className="text-xs text-zinc-500">Daemon: {health.data === undefined ? 'checking' : 'reachable'}</p>
        <div className="mt-4 space-y-2">
          {sessions.length === 0 ? (
            <EmptyState title="No sessions" detail="Spawn from the CLI or attach a running agent PID." />
          ) : (
            sessions.map((entry) => (
              <button
                key={entry.id}
                onClick={() => select(entry.id)}
                className="w-full rounded-md border border-zinc-200 p-2 text-left hover:bg-zinc-50 dark:border-zinc-800"
              >
                <div className="text-sm font-semibold">{entry.title}</div>
                <div className="text-xs text-zinc-500">
                  {entry.origin} {entry.lifecycle} pid={entry.pid}
                </div>
              </button>
            ))
          )}
        </div>
        <h2 className="mt-6 text-sm font-semibold">Discover</h2>
        <div className="mt-2 space-y-2">
          {candidates.map((entry) => (
            <div key={entry.pid} className="rounded-md border border-zinc-200 p-2 text-xs dark:border-zinc-800">
              <div className="font-semibold">
                {entry.pid} {entry.binaryName}
              </div>
              <div className="truncate text-zinc-500">{entry.commandLine}</div>
              <Button tone="quiet" className="mt-1 h-6 px-2 text-xs">
                Attach
              </Button>
            </div>
          ))}
        </div>
      </aside>
      <main className="flex-1 p-4">
        {selected === null ? (
          <EmptyState title="Select a session" detail="Choose a session on the left to see the live terminal." />
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold">{selected.title}</h2>
              <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-xs dark:bg-zinc-800">{selected.lifecycle}</span>
              <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-xs dark:bg-zinc-800">{selected.origin}</span>
            </div>
            <div className="text-xs text-zinc-500">
              pid={selected.pid} cwd={selected.cwd} branch={selected.branch ?? '-'}
            </div>
            <XTermView sessionId={selected.id} />
          </div>
        )}
      </main>
    </div>
  );
}
