import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, Tray, Menu, nativeImage } from 'electron';

let tray: Tray | null = null;

function dataDir(): string {
  return process.env['AGENTERM_DATA_DIR'] ?? join(homedir(), '.agenterm');
}

function readLockPort(): number | null {
  try {
    const raw = readFileSync(join(dataDir(), 'agentermd.lock'), 'utf8');
    const parsed = JSON.parse(raw) as { port?: number; pid?: number };
    if (typeof parsed.port === 'number') return parsed.port;
    return null;
  } catch {
    return null;
  }
}

/**
 * Ensure the daemon is running.
 *
 * Forwards the login PATH so agent binaries resolve inside GUI sessions.
 * The daemon stays alive when the window closes; explicit shutdown only.
 */
function ensureDaemon(): void {
  const port = readLockPort();
  if (port !== null) return;
  const entry = join(app.getAppPath(), '..', 'agentermd', 'index.js');
  if (!existsSync(entry)) return;
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, AGENTERM_PORT: '37241' }
  });
  child.unref();
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  if (process.env['ELECTRON_RENDERER_URL'] !== undefined) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function createTray(): void {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('agenterm');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open', click: () => createWindow() },
      { label: 'Quit', click: () => app.quit() }
    ])
  );
}

await app.whenReady();
ensureDaemon();
createTray();
createWindow();

app.on('window-all-closed', () => {
  // Daemon keeps running. Window close never kills agents.
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
