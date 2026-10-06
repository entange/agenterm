import { app, Notification } from 'electron';
import electronUpdater from 'electron-updater';

const SIX_HOURS = 6 * 60 * 60 * 1000;

/**
 * Background updates from GitHub releases for packaged builds.
 *
 * Downloads quietly and installs when the app quits. Agents are not
 * affected: they belong to the daemon, which keeps running across app
 * restarts. Unsigned builds cannot update on macOS; those errors are
 * ignored rather than shown.
 */
export function startUpdater(): void {
  if (!app.isPackaged || process.env['AGENTERM_DISABLE_UPDATES'] === '1') return;
  const { autoUpdater } = electronUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', () => undefined);
  autoUpdater.on('update-downloaded', (info) => {
    if (!Notification.isSupported()) return;
    new Notification({
      title: `agenterm ${info.version} is ready`,
      body: 'It installs the next time you quit agenterm. Running agents are not interrupted.'
    }).show();
  });
  const check = (): void => {
    void autoUpdater.checkForUpdates().catch(() => undefined);
  };
  check();
  setInterval(check, SIX_HOURS).unref();
}
