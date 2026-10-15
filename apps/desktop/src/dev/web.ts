import type { AgentermEvent } from '@agenterm/core';
import type {
  ActivityTick,
  AgentermBridge,
  AppCommand,
  CliStatus,
  ConnectionInfo,
  Preferences
} from '../../shared/bridge.js';

/**
 * Browser stand-in for the Electron preload, used only by the Vite web
 * harness (web.html). Talks to the dev server's bridge middleware, which
 * holds the token and the daemon link.
 */
type Handler<T> = (payload: T) => void;
const handlers = {
  event: new Set<Handler<AgentermEvent>>(),
  activity: new Set<Handler<ActivityTick>>(),
  connection: new Set<Handler<ConnectionInfo>>(),
  command: new Set<Handler<AppCommand>>()
};
let connection: ConnectionInfo = { state: 'starting', version: null, detail: null };
let socket: WebSocket | null = null;
const subscribed = new Set<string>();
let preferences: Preferences = { notifications: true };
// The browser has no app copy of the command; ?cli=missing (or installed, other) previews the others.
const cliState = (new URLSearchParams(location.search).get('cli') ?? 'unavailable') as CliStatus['state'];
let cli: CliStatus = {
  state: cliState,
  path: { installed: '/usr/local/bin/agenterm', other: '/opt/homebrew/bin/agenterm', missing: null, unavailable: null }[
    cliState
  ]
};

function connect(): void {
  const ws = new WebSocket(`ws://${location.host}/__agenterm/stream`);
  socket = ws;
  ws.onmessage = (message) => {
    const { kind, payload } = JSON.parse(String(message.data)) as { kind: keyof typeof handlers; payload: unknown };
    if (kind === 'connection') connection = payload as ConnectionInfo;
    if (kind === 'event') {
      const event = payload as AgentermEvent;
      if (event.kind === 'terminal.output' && !subscribed.has(event.taskId)) return;
    }
    for (const handler of handlers[kind]) (handler as Handler<unknown>)(payload);
  };
  ws.onopen = () => {
    for (const taskId of subscribed) ws.send(JSON.stringify({ kind: 'subscribe', taskId }));
  };
  ws.onclose = () => setTimeout(connect, 1000);
}
connect();

function on<K extends keyof typeof handlers>(kind: K, handler: Handler<never>): () => void {
  const set = handlers[kind] as Set<Handler<never>>;
  set.add(handler);
  return () => set.delete(handler);
}

const bridge: AgentermBridge = {
  // ?platform=darwin lays the title bar out as on a Mac, for screenshots.
  platform: new URLSearchParams(location.search).get('platform') ?? 'web',
  call: async (method, ...args) => {
    const response = await fetch('/__agenterm/call', { method: 'POST', body: JSON.stringify({ method, args }) });
    return (await response.json()) as never;
  },
  sendInput: (taskId, data) => socket?.send(JSON.stringify({ kind: 'input', taskId, data })),
  subscribeOutput: (taskId) => {
    subscribed.add(taskId);
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ kind: 'subscribe', taskId }));
  },
  unsubscribeOutput: (taskId) => {
    subscribed.delete(taskId);
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ kind: 'unsubscribe', taskId }));
  },
  onEvent: (handler) => on('event', handler as Handler<never>),
  onActivity: (handler) => on('activity', handler as Handler<never>),
  onConnection: (handler) => on('connection', handler as Handler<never>),
  onCommand: (handler) => on('command', handler as Handler<never>),
  connection: async () => connection,
  startDaemon: async () => {
    socket?.send(JSON.stringify({ kind: 'start' }));
    return connection;
  },
  stopDaemon: async () => false,
  openExternal: async (url) => {
    window.open(url, '_blank', 'noopener');
  },
  revealPath: async () => undefined,
  preferences: async () => preferences,
  setPreferences: async (patch) => {
    preferences = { ...preferences, ...patch };
    return preferences;
  },
  cliStatus: async () => cli,
  installCli: async () => {
    cli = { state: 'installed', path: '/usr/local/bin/agenterm' };
    return cli;
  }
};

(window as unknown as { agenterm: AgentermBridge }).agenterm = bridge;
// Keyboard stand-ins for menu accelerators the browser does not have.
window.addEventListener('keydown', (event) => {
  if (!(event.metaKey || event.ctrlKey)) return;
  const key = event.key.toLowerCase();
  const command: AppCommand | null =
    key === 'k'
      ? { kind: 'palette' }
      : key === ','
        ? { kind: 'settings' }
        : key === ']'
          ? { kind: 'cycle-task', delta: 1 }
          : key === '['
            ? { kind: 'cycle-task', delta: -1 }
            : null;
  if (command === null) return;
  event.preventDefault();
  for (const handler of handlers.command) handler(command);
});

// Screenshot helpers: ?theme=dark|light, ?group=project|agent|none, ?select=<id>, ?dialog=palette|settings.
const params = new URLSearchParams(location.search);
const theme = params.get('theme');
const group = params.get('group');
const storageKey = 'agenterm.ui.v2';
if (theme !== null || group !== null) {
  const stored = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Record<string, unknown>;
  localStorage.setItem(
    storageKey,
    JSON.stringify({
      ...stored,
      ...(theme === 'dark' || theme === 'light' || theme === 'system' ? { theme } : {}),
      ...(group === 'project' || group === 'agent' || group === 'none' ? { groupBy: group } : {})
    })
  );
}

await import('../main.js');

const { useUi } = await import('../lib/ui.js');
const select = params.get('select');
const dialog = params.get('dialog');
if (select !== null || dialog !== null) {
  const started = Date.now();
  const timer = setInterval(() => {
    void bridge.call('listTasks').then((result) => {
      if (!result.ok) return;
      const match = select === null ? undefined : result.value.tasks.find((task) => task.id.startsWith(select));
      if (match !== undefined) useUi.getState().select(match.id);
      if (dialog === 'palette') useUi.getState().setPaletteOpen(true);
      if (dialog === 'settings') useUi.getState().setSettingsOpen(true);
      if (match !== undefined || select === null || Date.now() - started > 5000) clearInterval(timer);
    });
  }, 300);
}
