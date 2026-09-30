import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } from 'electron';
import WebSocket from 'ws';

let tray: Tray | null = null;
let stream: WebSocket | null = null;
let streamTimer: ReturnType<typeof setTimeout> | null = null;

function dataDir(): string {
  return process.env['AGENTERM_DATA_DIR'] ?? join(homedir(), '.agenterm');
}

function readLock(): { port?: number; pid?: number } {
  try {
    return JSON.parse(readFileSync(join(dataDir(), 'agentermd.lock'), 'utf8')) as {
      port?: number;
      pid?: number;
    };
  } catch {
    return {};
  }
}

function readToken(): string {
  try {
    return readFileSync(join(dataDir(), 'token'), 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Ensure the daemon is running.
 *
 * Forwards the login PATH so agent binaries resolve inside GUI sessions.
 * The daemon stays alive when the window closes; explicit shutdown only.
 */
function ensureDaemon(): void {
  const lock = readLock();
  if (typeof lock.port === 'number') return;
  const entry = join(app.getAppPath(), '..', 'agentermd', 'index.js');
  if (!existsSync(entry)) return;
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, AGENTERM_PORT: '37241' }
  });
  child.unref();
}

async function daemonCall(pathname: string, init?: RequestInit): Promise<unknown> {
  const lock = readLock();
  if (typeof lock.port !== 'number') {
    throw new Error('daemon is not running');
  }
  const response = await fetch(`http://127.0.0.1:${lock.port}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${readToken()}`,
      ['Content-Type']: 'application/json',
      ...(init?.headers ?? {})
    }
  });
  const text = await response.text();
  const body: unknown = text.length > 0 ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    const nested = (body as { error?: { message?: string } } | null)?.error;
    throw new Error(typeof nested?.message === 'string' ? nested.message : `daemon call failed: ${pathname}`);
  }
  return body;
}

function broadcast(event: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send('agenterm:event', event);
    } catch {
      // Closed windows are skipped.
    }
  }
}

/** Keep one localhost stream open and forward every event to renderers. */
function openStream(): void {
  if (stream !== null || streamTimer !== null) return;
  const lock = readLock();
  if (typeof lock.port !== 'number') {
    streamTimer = setTimeout(() => {
      streamTimer = null;
      openStream();
    }, 2000);
    return;
  }
  const socket = new WebSocket(`ws://127.0.0.1:${lock.port}/events/stream`, {
    headers: { Authorization: `Bearer ${readToken()}` }
  });
  stream = socket;
  socket.on('message', (raw) => {
    try {
      const parsed = JSON.parse(String(raw)) as { kind?: string; event?: unknown };
      if (parsed.kind === 'event') {
        broadcast(parsed.event);
      }
    } catch {
      // Malformed frames are ignored; HTTP stays authoritative.
    }
  });
  const retry = (): void => {
    stream = null;
    if (streamTimer === null) {
      streamTimer = setTimeout(() => {
        streamTimer = null;
        openStream();
      }, 2000);
    }
  };
  socket.on('close', retry);
  socket.on('error', () => {
    try {
      socket.close();
    } catch {
      // Already closing.
    }
  });
}

function registerIpc(): void {
  ipcMain.handle('agenterm:health', () => daemonCall('/health'));
  ipcMain.handle('agenterm:discover', () => daemonCall('/discover'));
  ipcMain.handle('agenterm:list', () => daemonCall('/sessions'));
  ipcMain.handle('agenterm:spawn', (_event, body: unknown) =>
    daemonCall('/sessions', { method: 'POST', body: JSON.stringify(body) })
  );
  ipcMain.handle('agenterm:attach', (_event, body: unknown) =>
    daemonCall('/sessions/attach', { method: 'POST', body: JSON.stringify(body) })
  );
  ipcMain.handle('agenterm:detail', (_event, id: string) =>
    daemonCall(`/sessions/${encodeURIComponent(id)}`)
  );
  ipcMain.handle('agenterm:output', (_event, id: string, sinceSeq?: number) => {
    const suffix = typeof sinceSeq === 'number' ? `?sinceSeq=${sinceSeq}` : '';
    return daemonCall(`/sessions/${encodeURIComponent(id)}/output${suffix}`);
  });
  ipcMain.handle('agenterm:commands', (_event, id: string) =>
    daemonCall(`/sessions/${encodeURIComponent(id)}/commands`)
  );
  ipcMain.handle('agenterm:input', (_event, id: string, data: string) =>
    daemonCall(`/sessions/${encodeURIComponent(id)}/input`, {
      method: 'POST',
      body: JSON.stringify({ data })
    })
  );
  ipcMain.handle('agenterm:resize', (_event, id: string, cols: number, rows: number) =>
    daemonCall(`/sessions/${encodeURIComponent(id)}/resize`, {
      method: 'POST',
      body: JSON.stringify({ cols, rows })
    })
  );
  ipcMain.handle('agenterm:signal', (_event, id: string, signal: string) =>
    daemonCall(`/sessions/${encodeURIComponent(id)}/signal`, {
      method: 'POST',
      body: JSON.stringify({ signal })
    })
  );
  ipcMain.handle('agenterm:kill', (_event, id: string, killTree: boolean) =>
    daemonCall(`/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      body: JSON.stringify({ killTree })
    })
  );
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
registerIpc();
openStream();
createTray();
createWindow();

app.on('window-all-closed', () => {
  // Daemon keeps running. Window close never kills agents.
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
