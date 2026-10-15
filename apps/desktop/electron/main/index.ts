import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentermApiError, isRunning, type TaskRecord } from '@agenterm/core';
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
import {
  API_METHODS,
  IPC,
  type ApiFailure,
  type AppCommand,
  type CliStatus,
  type Preferences
} from '../../shared/bridge.js';
import { taskLabel } from '../../shared/label.js';
import { bundledCommand, COMMAND_LINK, commandStatus, linkCommand } from './cliCommand.js';
import { DaemonLink, dataDir } from './daemonLink.js';
import { loadLoginEnv } from './loginEnv.js';
import { TaskMonitor } from './monitor.js';
import { startUpdater } from './updater.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === 'darwin';
const devUrl = process.env['ELECTRON_RENDERER_URL'];

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const loginEnv = loadLoginEnv();
const link = new DaemonLink({
  loginEnv,
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath
});
/** The agenterm command inside this app, which /usr/local/bin/agenterm links to. */
const bundledCli = bundledCommand({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath });
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

function savePreferences(next: Preferences): void {
  preferences = next;
  fs.mkdirSync(path.dirname(preferencesFile()), { recursive: true });
  fs.writeFileSync(preferencesFile(), JSON.stringify(next, null, 2));
}

// --- the agenterm command --------------------------------------------------

async function cliStatus(): Promise<CliStatus> {
  return commandStatus(bundledCli, (await loginEnv)['PATH']);
}

/**
 * Put the agenterm command on the PATH so agents can start tasks without a
 * separate install. Quietly when no password is needed (first install on a
 * writable /usr/local/bin, or relinking after the app moved); otherwise ask
 * once, since macOS then wants an administrator password. Settings can add
 * it any time after.
 */
async function offerCommand(): Promise<void> {
  if (bundledCli === null || (await cliStatus()).state !== 'missing') return;
  if (await linkCommand(bundledCli, { askForPassword: false, replace: false })) return;
  if (preferences.commandOffered === true) return;
  savePreferences({ ...preferences, commandOffered: true });
  const options: Electron.MessageBoxOptions = {
    type: 'question',
    buttons: ['Add Command', 'Not Now'],
    defaultId: 0,
    cancelId: 1,
    message: 'Add the agenterm command?',
    detail: `Agents start tasks with the agenterm command, and connect over MCP with agenterm mcp. agenterm can put it at ${COMMAND_LINK} so every terminal and agent finds it; macOS asks for your password once.\n\nYou can also do this later in Settings.`
  };
  const win = mainWindow;
  const { response } =
    win === null || win.isDestroyed()
      ? await dialog.showMessageBox(options)
      : await dialog.showMessageBox(win, options);
  if (response === 0) await linkCommand(bundledCli, { askForPassword: true, replace: false });
}

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
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0B0B0C' : '#F4F4F5',
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
  // Links printed by tasks never navigate the privileged window.
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
    for (const taskId of outputSubscriptions.get(contentsId) ?? []) link.unsubscribe(taskId);
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
  ipcMain.on(IPC.input, (event, taskId: unknown, data: unknown) => {
    if (!trusted(event) || typeof taskId !== 'string' || typeof data !== 'string' || data.length === 0) return;
    link.sendInput(taskId, data);
  });
  ipcMain.on(IPC.subscribe, (event, taskId: unknown) => {
    if (!trusted(event) || typeof taskId !== 'string') return;
    const set = outputSubscriptions.get(event.sender.id) ?? new Set<string>();
    if (!set.has(taskId)) link.subscribe(taskId);
    set.add(taskId);
    outputSubscriptions.set(event.sender.id, set);
  });
  ipcMain.on(IPC.unsubscribe, (event, taskId: unknown) => {
    if (typeof taskId === 'string' && outputSubscriptions.get(event.sender.id)?.delete(taskId) === true) {
      link.unsubscribe(taskId);
    }
  });
  ipcMain.handle(IPC.getConnection, () => link.connection());
  ipcMain.handle(IPC.startDaemon, (event) => (trusted(event) ? link.ensure(true) : link.connection()));
  ipcMain.handle(IPC.stopDaemon, async (event) => (trusted(event) ? confirmAndStopDaemon() : false));
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
    savePreferences(next);
    return next;
  });
  ipcMain.handle(IPC.cliStatus, () => cliStatus());
  ipcMain.handle(IPC.installCli, async (event) => {
    if (trusted(event) && bundledCli !== null) await linkCommand(bundledCli, { askForPassword: true, replace: true });
    return cliStatus();
  });
}

async function confirmAndStopDaemon(): Promise<boolean> {
  const running = monitor.list().filter(isRunning).length;
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    buttons: ['Stop daemon', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: 'Stop the agenterm daemon?',
    detail:
      running > 0
        ? `${running} running ${running === 1 ? 'task' : 'tasks'} will end.`
        : 'No tasks are running. The CLI and the app start it again when needed.'
  };
  const win = BrowserWindow.getFocusedWindow();
  const { response } = win === null ? await dialog.showMessageBox(options) : await dialog.showMessageBox(win, options);
  if (response !== 0) return false;
  return link.stop();
}

// --- menus -----------------------------------------------------------------

function buildAppMenu(): void {
  const jump: MenuItemConstructorOptions[] = Array.from({ length: 9 }, (_, i) => ({
    label: `Task ${i + 1}`,
    accelerator: isMac ? `Cmd+${i + 1}` : `Alt+${i + 1}`,
    click: () => sendCommand({ kind: 'jump-task', index: i })
  }));
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            role: 'appMenu' as const,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { label: 'Settings…', accelerator: 'Cmd+,', click: () => sendCommand({ kind: 'settings' }) },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: 'File',
      submenu: [
        ...(isMac
          ? []
          : [
              { label: 'Settings…', accelerator: 'Ctrl+,', click: () => sendCommand({ kind: 'settings' }) },
              { type: 'separator' as const }
            ]),
        { label: 'Open Data Folder', click: () => void shell.openPath(dataDir()) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Find Task…', accelerator: accel('K'), click: () => sendCommand({ kind: 'palette' }) },
        { type: 'separator' },
        {
          label: 'Previous Task',
          accelerator: accel('['),
          click: () => sendCommand({ kind: 'cycle-task', delta: -1 })
        },
        { label: 'Next Task', accelerator: accel(']'), click: () => sendCommand({ kind: 'cycle-task', delta: 1 }) },
        { label: 'Go to Task', submenu: jump },
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
        { label: 'agenterm on GitHub', click: () => void shell.openExternal('https://github.com/entange/agenterm') }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function buildTrayMenu(tasks: TaskRecord[]): void {
  if (tray === null) return;
  const running = tasks.filter(isRunning);
  const summary = running.length === 0 ? 'Nothing running' : `${running.length} running`;
  const rows: MenuItemConstructorOptions[] = running.slice(0, 10).map((task) => ({
    label: `${taskLabel(task)}${task.ports.length > 0 ? `  :${task.ports.join(' :')}` : ''}`,
    click: () => sendCommand({ kind: 'focus-task', taskId: task.id })
  }));
  const connected = link.connection().state === 'online';
  tray.setToolTip(`agenterm — ${summary}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: connected ? summary : 'Daemon offline', enabled: false },
      ...(rows.length > 0 ? [{ type: 'separator' as const }, ...rows] : []),
      { type: 'separator' },
      { label: 'Open agenterm', click: () => showWindow() },
      { type: 'separator' },
      connected
        ? { label: 'Stop Daemon…', click: () => void confirmAndStopDaemon() }
        : { label: 'Start Daemon', click: () => void link.ensure() },
      { label: 'Quit agenterm (tasks keep running)', role: 'quit' }
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

const monitor = new TaskMonitor({
  link,
  enabled: () => preferences.notifications,
  hasFocus: () => BrowserWindow.getFocusedWindow() !== null,
  onOpenTask: (taskId) => sendCommand({ kind: 'focus-task', taskId }),
  onTasks: (tasks) => buildTrayMenu(tasks)
});

link.onEvent((event) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    if (event.kind === 'terminal.output' && outputSubscriptions.get(win.webContents.id)?.has(event.taskId) !== true)
      continue;
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
  // The daemon and the tray stay; closing the window never stops tasks.
});
app.on('before-quit', () => {
  monitor.dispose();
  link.dispose();
});

// Never top-level await here: Electron fires 'ready' only after the ESM entry finishes
// evaluating, so awaiting it in the entry deadlocks with a bouncing dock icon.
void app.whenReady().then(() => {
  preferences = readPreferences();
  app.setName('agenterm');
  if (isMac) app.dock?.setIcon(resource('icon.png'));
  electronSession.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  registerIpc();
  buildAppMenu();
  createTray();
  mainWindow = createWindow();
  mainWindow.once('ready-to-show', () => void offerCommand());
  void link.ensure();
  startUpdater();
});
