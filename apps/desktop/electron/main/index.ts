import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionRecord } from '@agenterm/core';
import { AgentermApiError } from '@agenterm/core';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  session as electronSession,
  shell,
  Tray,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions
} from 'electron';
import { API_METHODS, IPC, type ApiFailure, type AppCommand, type Preferences } from '../../shared/bridge.js';
import { callsign } from '../../shared/callsign.js';
import { DaemonLink, dataDir } from './daemonLink.js';
import { loadLoginEnv } from './loginEnv.js';
import { AttentionMonitor } from './monitor.js';
import { startUpdater } from './updater.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === 'darwin';
const devUrl = process.env['ELECTRON_RENDERER_URL'];

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const link = new DaemonLink({
  loginEnv: loadLoginEnv(),
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath
});
/** Terminal output subscriptions per renderer, keyed by webContents id. */
const outputSubscriptions = new Map<number, Set<string>>();
let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;

// --- preferences -----------------------------------------------------------

const DEFAULT_PREFERENCES: Preferences = { notifications: true };

function preferencesFile(): string {
  return path.join(app.getPath('userData'), 'preferences.json');
}

function readPreferences(): Preferences {
  try {
    return {
      ...DEFAULT_PREFERENCES,
      ...(JSON.parse(fs.readFileSync(preferencesFile(), 'utf8')) as Partial<Preferences>)
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

let preferences = DEFAULT_PREFERENCES;

// --- windows ---------------------------------------------------------------

function resource(name: string): string {
  return app.isPackaged ? path.join(process.resourcesPath, name) : path.join(here, '..', '..', 'resources', name);
}

function sendCommand(command: AppCommand): void {
  const win = showWindow();
  const deliver = (): void => win.webContents.send(IPC.command, command);
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', deliver);
  else deliver();
}

function showWindow(): BrowserWindow {
  if (mainWindow === null || mainWindow.isDestroyed()) {
    mainWindow = createWindow();
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  return mainWindow;
}

function isTrustedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (devUrl !== undefined && parsed.origin === new URL(devUrl).origin) return true;
    if (parsed.protocol !== 'file:' || parsed.host !== '') return false;
    const file = fileURLToPath(parsed);
    return file.startsWith(path.join(here, '..', 'renderer') + path.sep);
  } catch {
    return false;
  }
}

/**
 * App shortcut for a key. macOS uses Cmd; elsewhere Ctrl+Shift, because
 * plain Ctrl+K, Ctrl+N, Ctrl+J, Ctrl+[ belong to the program in the terminal.
 */
function accel(key: string): string {
  return isMac ? `Cmd+${key}` : `Ctrl+Shift+${key}`;
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'agenterm',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#11161D' : '#EEF1F5',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 15 },
    ...(isMac ? {} : { icon: resource('icon.png') }),
    webPreferences: {
      preload: path.join(here, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false
    }
  });
  win.once('ready-to-show', () => win.show());
  // Links printed by agents never navigate the privileged window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedUrl(url)) {
      event.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });
  const contentsId = win.webContents.id;
  win.on('closed', () => {
    outputSubscriptions.delete(contentsId);
    if (mainWindow === win) mainWindow = null;
  });
  if (devUrl !== undefined) void win.loadURL(devUrl);
  else void win.loadFile(path.join(here, '..', 'renderer', 'index.html'));
  if (!app.isPackaged && process.env['AGENTERM_CAPTURE'] !== undefined)
    captureForDevelopment(win, process.env['AGENTERM_CAPTURE']);
  return win;
}

/**
 * Development-only screenshot hook used for visual checks and smoke tests:
 * waits, optionally runs AGENTERM_CAPTURE_SCRIPT in the page, writes a PNG
 * to the given path, and quits. Never active in packaged builds.
 */
function captureForDevelopment(win: BrowserWindow, file: string): void {
  win.webContents.once('did-finish-load', () => {
    void (async () => {
      const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
      await wait(Number(process.env['AGENTERM_CAPTURE_DELAY'] ?? '4000'));
      const script = process.env['AGENTERM_CAPTURE_SCRIPT'];
      if (script !== undefined) {
        await win.webContents
          .executeJavaScript(script)
          .catch((error: unknown) => console.error('capture script failed', error));
        await wait(Number(process.env['AGENTERM_CAPTURE_SETTLE'] ?? '1500'));
      }
      const image = await win.webContents.capturePage();
      fs.writeFileSync(file, image.toPNG());
      app.exit(0);
    })();
  });
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

// --- IPC -------------------------------------------------------------------

function trusted(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  const frame = event.senderFrame;
  return frame !== null && frame === event.sender.mainFrame && isTrustedUrl(frame.url);
}

function failure(error: unknown): ApiFailure {
  if (error instanceof AgentermApiError) {
    return { status: error.status, code: error.code, message: error.message, hint: error.hint };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/ECONNREFUSED|fetch failed/.test(message)) {
    return {
      status: 0,
      code: 'daemon_offline',
      message: 'The daemon is not reachable.',
      hint: 'It restarts automatically; try again in a moment.'
    };
  }
  return { status: 0, code: 'internal', message };
}

function registerIpc(): void {
  ipcMain.handle(IPC.call, async (event, method: unknown, args: unknown) => {
    if (!trusted(event)) return { ok: false, error: { status: 403, code: 'untrusted', message: 'untrusted sender' } };
    if (typeof method !== 'string' || !(API_METHODS as readonly string[]).includes(method) || !Array.isArray(args)) {
      return { ok: false, error: { status: 400, code: 'bad_call', message: 'unknown method' } };
    }
    try {
      const client = link.client();
      const fn = (client as unknown as Record<string, (...rest: unknown[]) => Promise<unknown>>)[method];
      if (fn === undefined) throw new Error('unknown method');
      const value = await fn.apply(client, args);
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: failure(error) };
    }
  });
  ipcMain.on(IPC.input, (event, sessionId: unknown, data: unknown) => {
    if (!trusted(event) || typeof sessionId !== 'string' || typeof data !== 'string' || data.length === 0) return;
    link.sendInput(sessionId, data);
  });
  ipcMain.on(IPC.subscribe, (event, sessionId: unknown) => {
    if (!trusted(event) || typeof sessionId !== 'string') return;
    const set = outputSubscriptions.get(event.sender.id) ?? new Set<string>();
    set.add(sessionId);
    outputSubscriptions.set(event.sender.id, set);
  });
  ipcMain.on(IPC.unsubscribe, (event, sessionId: unknown) => {
    if (typeof sessionId === 'string') outputSubscriptions.get(event.sender.id)?.delete(sessionId);
  });
  ipcMain.handle(IPC.getConnection, () => link.connection());
  ipcMain.handle(IPC.startDaemon, (event) => (trusted(event) ? link.ensure() : link.connection()));
  ipcMain.handle(IPC.stopDaemon, async (event) => (trusted(event) ? confirmAndStopDaemon() : false));
  ipcMain.handle(IPC.pickDirectory, async (event, defaultPath: unknown) => {
    if (!trusted(event)) return null;
    const win = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      title: 'Choose a working folder',
      properties: ['openDirectory', 'createDirectory'],
      ...(typeof defaultPath === 'string' && path.isAbsolute(defaultPath) ? { defaultPath } : {})
    };
    const result = win === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(win, options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle(IPC.openExternal, async (event, url: unknown) => {
    if (trusted(event) && typeof url === 'string' && /^https?:\/\//.test(url)) await shell.openExternal(url);
  });
  ipcMain.handle(IPC.revealPath, async (event, target: unknown) => {
    if (!trusted(event) || typeof target !== 'string' || !path.isAbsolute(target) || !fs.existsSync(target)) return;
    if (fs.statSync(target).isDirectory()) await shell.openPath(target);
    else shell.showItemInFolder(target);
  });
  ipcMain.handle(IPC.preferences, () => preferences);
  ipcMain.handle(IPC.setPreferences, (event, patch: unknown) => {
    if (!trusted(event) || typeof patch !== 'object' || patch === null) return preferences;
    const next = { ...preferences };
    const record = patch as Record<string, unknown>;
    if (typeof record['notifications'] === 'boolean') next.notifications = record['notifications'];
    preferences = next;
    fs.mkdirSync(path.dirname(preferencesFile()), { recursive: true });
    fs.writeFileSync(preferencesFile(), JSON.stringify(next, null, 2));
    return next;
  });
}

async function confirmAndStopDaemon(): Promise<boolean> {
  const running = monitor
    .list()
    .filter((session) => session.lifecycle === 'running' && session.origin === 'spawned').length;
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    buttons: ['Stop daemon', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: 'Stop the agenterm daemon?',
    detail:
      running > 0
        ? `${running} running ${running === 1 ? 'agent' : 'agents'} started by agenterm will end. Attached processes keep running.`
        : 'Nothing started by agenterm is running. You can start the daemon again from the app.'
  };
  const win = BrowserWindow.getFocusedWindow();
  const { response } = win === null ? await dialog.showMessageBox(options) : await dialog.showMessageBox(win, options);
  if (response !== 0) return false;
  return link.stop();
}

// --- menus -----------------------------------------------------------------

function buildAppMenu(): void {
  const jump: MenuItemConstructorOptions[] = Array.from({ length: 9 }, (_, i) => ({
    label: `Session ${i + 1}`,
    accelerator: isMac ? `Cmd+${i + 1}` : `Alt+${i + 1}`,
    click: () => sendCommand({ kind: 'jump-session', index: i })
  }));
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Session…', accelerator: accel('N'), click: () => sendCommand({ kind: 'new-session' }) },
        { type: 'separator' },
        { label: 'Open Data Folder', click: () => void shell.openPath(dataDir()) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Command Palette', accelerator: accel('K'), click: () => sendCommand({ kind: 'palette' }) },
        {
          label: 'Control Room',
          accelerator: isMac ? 'Cmd+Shift+H' : 'Ctrl+Shift+H',
          click: () => sendCommand({ kind: 'home' })
        },
        { label: 'Activity', accelerator: accel('J'), click: () => sendCommand({ kind: 'toggle-activity' }) },
        { type: 'separator' },
        {
          label: 'Previous Session',
          accelerator: accel('['),
          click: () => sendCommand({ kind: 'cycle-session', delta: -1 })
        },
        {
          label: 'Next Session',
          accelerator: accel(']'),
          click: () => sendCommand({ kind: 'cycle-session', delta: 1 })
        },
        { label: 'Go to Session', submenu: jump },
        { type: 'separator' },
        ...(app.isPackaged
          ? []
          : [{ role: 'reload' as const }, { role: 'toggleDevTools' as const }, { type: 'separator' as const }]),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Show Daemon Log', click: () => shell.showItemInFolder(path.join(dataDir(), 'daemon.log')) },
        { label: 'agenterm on GitHub', click: () => void shell.openExternal('https://github.com/') }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function buildTrayMenu(sessions: SessionRecord[]): void {
  if (tray === null) return;
  const live = sessions.filter((session) => session.lifecycle === 'running');
  const waiting = live.filter(
    (session) => session.overlay === 'waiting_permission' || session.overlay === 'waiting_input'
  );
  const summary =
    live.length === 0
      ? 'No agents running'
      : `${live.length} running${waiting.length > 0 ? ` · ${waiting.length} waiting on you` : ''}`;
  const rows: MenuItemConstructorOptions[] = [...waiting, ...live.filter((session) => !waiting.includes(session))]
    .slice(0, 8)
    .map((session) => ({
      label: `${waiting.includes(session) ? '● ' : ''}${callsign(session)}  ${session.title}`,
      click: () => sendCommand({ kind: 'focus-session', sessionId: session.id })
    }));
  const connected = link.connection().state === 'online';
  tray.setToolTip(`agenterm — ${summary}`);
  if (isMac) tray.setTitle(waiting.length > 0 ? String(waiting.length) : '');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: connected ? summary : 'Daemon offline', enabled: false },
      ...(rows.length > 0 ? [{ type: 'separator' as const }, ...rows] : []),
      { type: 'separator' },
      { label: 'Open agenterm', click: () => showWindow() },
      { label: 'New Session…', click: () => sendCommand({ kind: 'new-session' }) },
      { type: 'separator' },
      connected
        ? { label: 'Stop Daemon…', click: () => void confirmAndStopDaemon() }
        : { label: 'Start Daemon', click: () => void link.ensure() },
      { label: 'Quit agenterm (agents keep running)', role: 'quit' }
    ])
  );
}

function createTray(): void {
  const image = nativeImage.createFromPath(resource('trayTemplate.png'));
  image.setTemplateImage(true);
  tray = new Tray(image);
  tray.on('click', () => {
    if (!isMac) showWindow();
  });
  buildTrayMenu([]);
}

// --- boot ------------------------------------------------------------------

const monitor = new AttentionMonitor({
  link,
  enabled: () => preferences.notifications,
  hasFocus: () => BrowserWindow.getFocusedWindow() !== null,
  onOpenSession: (sessionId) => sendCommand({ kind: 'focus-session', sessionId }),
  onSessions: (sessions) => buildTrayMenu(sessions)
});

link.onEvent((event) => {
  const terminal = event.kind === 'terminal.output' || event.kind === 'terminal.input';
  if (event.kind === 'session.detached') link.forget(event.sessionId);
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    if (terminal && outputSubscriptions.get(win.webContents.id)?.has(event.sessionId) !== true) continue;
    win.webContents.send(IPC.event, event);
  }
});
link.onActivity((tick) => broadcast(IPC.activity, tick));
link.onConnection((info) => {
  broadcast(IPC.connection, info);
  buildTrayMenu(monitor.list());
});

app.on('second-instance', () => showWindow());
app.on('activate', () => showWindow());
app.on('window-all-closed', () => {
  // The daemon and the tray stay; closing the window never stops agents.
});
app.on('before-quit', () => {
  monitor.dispose();
  link.dispose();
});

await app.whenReady();
preferences = readPreferences();
app.setName('agenterm');
if (isMac) app.dock?.setIcon(resource('icon.png'));
electronSession.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
registerIpc();
buildAppMenu();
createTray();
mainWindow = createWindow();
void link.ensure();
startUpdater();
