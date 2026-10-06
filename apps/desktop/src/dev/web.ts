import type { AgentermEvent } from '@agenterm/core';
import type { ActivityTick, AgentermBridge, AppCommand, ConnectionInfo, Preferences } from '../../shared/bridge.js';

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

function connect(): void {
  const ws = new WebSocket(`ws://${location.host}/__agenterm/stream`);
  socket = ws;
  ws.onmessage = (message) => {
    const { kind, payload } = JSON.parse(String(message.data)) as { kind: keyof typeof handlers; payload: unknown };
    if (kind === 'connection') connection = payload as ConnectionInfo;
    if (kind === 'event') {
      const event = payload as AgentermEvent;
      if ((event.kind === 'terminal.output' || event.kind === 'terminal.input') && !subscribed.has(event.sessionId))
        return;
    }
    for (const handler of handlers[kind]) (handler as Handler<unknown>)(payload);
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
  platform: 'web',
  call: async (method, ...args) => {
    const response = await fetch('/__agenterm/call', { method: 'POST', body: JSON.stringify({ method, args }) });
    return (await response.json()) as never;
  },
  sendInput: (sessionId, data) => socket?.send(JSON.stringify({ kind: 'input', sessionId, data })),
  subscribeOutput: (sessionId) => subscribed.add(sessionId),
  unsubscribeOutput: (sessionId) => subscribed.delete(sessionId),
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
  pickDirectory: async () => window.prompt('Folder (absolute path)'),
  openExternal: async (url) => {
    window.open(url, '_blank', 'noopener');
  },
  revealPath: async () => undefined,
  preferences: async () => preferences,
  setPreferences: async (patch) => {
    preferences = { ...preferences, ...patch };
    return preferences;
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
      : key === 'j'
        ? { kind: 'toggle-activity' }
        : event.shiftKey && key === 'h'
          ? { kind: 'home' }
          : null;
  if (command === null) return;
  event.preventDefault();
  for (const handler of handlers.command) handler(command);
});

// Screenshot helpers: ?theme=dark|light, ?select=<id prefix>&tab=<tab>, ?dialog=new|palette.
const params = new URLSearchParams(location.search);
const theme = params.get('theme');
if (theme === 'dark' || theme === 'light') {
  const key = 'agenterm.ui.v1';
  const stored = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
  localStorage.setItem(key, JSON.stringify({ ...stored, theme }));
}

await import('../main.js');

const { useUi } = await import('../lib/ui.js');
const select = params.get('select');
const tab = params.get('tab');
const dialog = params.get('dialog');
if (select !== null || dialog !== null) {
  const started = Date.now();
  const timer = setInterval(() => {
    void bridge.call('listSessions').then((result) => {
      if (!result.ok) return;
      const match =
        select === null ? undefined : result.value.sessions.find((session) => session.id.startsWith(select));
      if (match !== undefined) useUi.getState().select(match.id, (tab ?? 'terminal') as never);
      if (dialog === 'new') useUi.getState().setNewSessionOpen(true);
      if (dialog === 'palette') useUi.getState().setPaletteOpen(true);
      if (match !== undefined || select === null || Date.now() - started > 5000) clearInterval(timer);
    });
  }, 300);
}
