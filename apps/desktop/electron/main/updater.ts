import fs from 'node:fs';
import path from 'node:path';
import { app, Notification, shell } from 'electron';
import electronUpdater from 'electron-updater';

const SIX_HOURS = 6 * 60 * 60 * 1000;
const RELEASES = 'https://github.com/entange/agenterm/releases/latest';

/** Whether this build was signed with a Developer ID; packaging records it in package.json. */
function signedBuild(): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')) as {
      agenterm?: { signed?: boolean };
    };
    return pkg.agenterm?.signed === true;
  } catch {
    return false;
  }
}

function notify(title: string, body: string, onClick?: () => void): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body });
  if (onClick !== undefined) notification.on('click', onClick);
  notification.show();
}

/**
 * Updates from GitHub releases for packaged builds.
 *
 * Signed builds download quietly and install when the app quits. macOS
 * refuses to install updates into an unsigned (ad-hoc signed) app, so those
 * builds only say that a new version is out and link to the download.
 * Tasks are not affected either way: they belong to the daemon, which keeps
 * running across app restarts.
 */
export function startUpdater(): void {
  if (!app.isPackaged || process.env['AGENTERM_DISABLE_UPDATES'] === '1') return;
  const { autoUpdater } = electronUpdater;
  const canInstall = process.platform !== 'darwin' || signedBuild();
  autoUpdater.autoDownload = canInstall;
  autoUpdater.autoInstallOnAppQuit = canInstall;
  autoUpdater.on('error', () => undefined);
  let announced: string | null = null;
  autoUpdater.on('update-available', (info) => {
    if (canInstall || announced === info.version) return;
    announced = info.version;
    notify(`agenterm ${info.version} is available`, 'Click to download it. Running tasks are not interrupted.', () => {
      void shell.openExternal(RELEASES);
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    notify(
      `agenterm ${info.version} is ready`,
      'It installs the next time you quit agenterm. Running tasks are not interrupted.'
    );
  });
  const check = (): void => {
    void autoUpdater.checkForUpdates().catch(() => undefined);
  };
  check();
  setInterval(check, SIX_HOURS).unref();
}
