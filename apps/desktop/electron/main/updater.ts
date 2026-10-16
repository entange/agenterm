import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { app, Notification } from 'electron';
import {
  entriesBetween,
  newestRelease,
  parseChangelog,
  type GithubRelease,
  type UpdateInfo,
  type UpdateState,
  type UpdateStatus
} from '../../shared/update.js';

const run = promisify(execFile);
const SIX_HOURS = 6 * 60 * 60 * 1000;
const BUNDLE_ID = 'com.entange.agenterm';
// AGENTERM_UPDATE_SOURCE points the updater at a local server, to try an update before releasing it (docs/RELEASING.md).
const SOURCE = process.env['AGENTERM_UPDATE_SOURCE'];
const RELEASES_URL =
  SOURCE === undefined ? 'https://api.github.com/repos/entange/agenterm/releases?per_page=20' : `${SOURCE}/releases`;
const changelogUrl = (tag: string): string =>
  SOURCE === undefined
    ? `https://raw.githubusercontent.com/entange/agenterm/${tag}/CHANGELOG.md`
    : `${SOURCE}/${tag}/CHANGELOG.md`;

/**
 * Swaps the app bundle once the app has quit: waits for the pid to exit,
 * moves the running copy aside, moves the new one in (or the old one
 * back if that fails), then opens it when asked to. Arguments: pid,
 * installed app, new app, where to put the old one, relaunch (1 or 0).
 */
export const INSTALL_SCRIPT = `#!/bin/sh
pid="$1"; app="$2"; new="$3"; old="$4"; relaunch="$5"
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
rm -rf "$old"
if mv "$app" "$old"; then
  if mv "$new" "$app"; then
    rm -rf "$old"
  else
    mv "$old" "$app"
  fi
fi
xattr -dr com.apple.quarantine "$app" 2>/dev/null
if [ "$relaunch" = 1 ]; then open "$app"; fi
`;

/** The .app this process runs from: /Applications/agenterm.app for an installed copy. */
function appBundle(): string {
  return path.resolve(process.execPath, '..', '..', '..');
}

/** Why an update cannot replace the app where it is, or null when it can. */
export function installBlocker(bundle: string): string | null {
  if (!bundle.endsWith('.app')) return 'agenterm is not running from an app bundle.';
  if (bundle.startsWith('/Volumes/'))
    return 'agenterm is running from the disk image. Drag it into Applications first.';
  if (bundle.includes('/AppTranslocation/')) {
    return 'macOS is running agenterm from a temporary copy. Move it into Applications and open it from there.';
  }
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
    fs.accessSync(bundle, fs.constants.W_OK);
  } catch {
    return `agenterm cannot write to ${path.dirname(bundle)}.`;
  }
  return null;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': `agenterm/${app.getVersion()}` }
  });
  if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}`);
  return (await response.json()) as T;
}

/**
 * Updates from GitHub releases for the packaged macOS app.
 *
 * The app is ad-hoc signed, which macOS's own updater refuses, so this one
 * does the work: it downloads the zip for this Mac, checks it against the
 * checksum GitHub lists for it, unpacks it, and swaps the app when it quits
 * (or right away with a relaunch). Tasks belong to the daemon, which keeps
 * running across the swap.
 */
export class Updater {
  private state: UpdateState = { kind: 'idle', checkedAtMs: null };
  private release: GithubRelease | null = null;
  private staged: string | null = null;
  private installing = false;
  private announced: string | null = null;
  readonly enabled: boolean;
  private readonly work = path.join(app.getPath('temp'), 'agenterm-update');

  constructor(
    private readonly options: {
      onChange: (status: UpdateStatus) => void;
      hasFocus: () => boolean;
      onShow: () => void;
    }
  ) {
    this.enabled = app.isPackaged && process.platform === 'darwin' && process.env['AGENTERM_DISABLE_UPDATES'] !== '1';
  }

  start(): void {
    if (!this.enabled) return;
    // Whatever an earlier run downloaded is either installed by now or stale.
    fs.rmSync(this.work, { recursive: true, force: true });
    setTimeout(() => void this.check(false), 5000).unref();
    setInterval(() => void this.check(false), SIX_HOURS).unref();
  }

  status(): UpdateStatus {
    return { current: app.getVersion(), enabled: this.enabled, state: this.state };
  }

  private set(state: UpdateState): void {
    this.state = state;
    this.options.onChange(this.status());
  }

  /** Look for a newer release. Background checks that fail stay quiet. */
  async check(manual = true): Promise<UpdateStatus> {
    const busy = ['checking', 'downloading', 'ready'].includes(this.state.kind);
    if (!this.enabled || busy || this.installing) return this.status();
    const before = this.state;
    this.set({ kind: 'checking' });
    try {
      const release = newestRelease(await getJson<GithubRelease[]>(RELEASES_URL), app.getVersion());
      this.release = release;
      if (release === null) {
        this.set({ kind: 'idle', checkedAtMs: Date.now() });
        return this.status();
      }
      const update = await this.describe(release);
      const blocker = installBlocker(appBundle());
      this.set(blocker === null ? { kind: 'available', update } : { kind: 'manual', update, reason: blocker });
      this.announce(update);
    } catch (error) {
      this.set(manual ? { kind: 'error', message: messageOf(error), update: null } : before);
    }
    return this.status();
  }

  private async describe(release: GithubRelease): Promise<UpdateInfo> {
    const version = release.tag_name.slice(1);
    let entries: UpdateInfo['entries'] = [];
    try {
      const response = await fetch(changelogUrl(release.tag_name));
      if (response.ok) entries = entriesBetween(parseChangelog(await response.text()), app.getVersion(), version);
    } catch {
      // The release page still lists the changes.
    }
    return { version, url: release.html_url, entries };
  }

  private announce(update: UpdateInfo): void {
    if (this.announced === update.version || this.options.hasFocus() || !Notification.isSupported()) return;
    this.announced = update.version;
    const notification = new Notification({
      title: `agenterm ${update.version} is available`,
      body: 'Click to see what changed and install it. Running tasks keep running.'
    });
    notification.on('click', () => this.options.onShow());
    notification.show();
  }

  /** Download the update for this Mac, check it, and unpack it, ready to install. */
  async download(): Promise<UpdateStatus> {
    const release = this.release;
    const update = this.state.kind === 'available' || this.state.kind === 'error' ? this.state.update : null;
    if (release === null || update === null) return this.status();
    const name = `agenterm-${update.version}-${process.arch}-mac.zip`;
    const asset = release.assets.find((entry) => entry.name === name);
    try {
      if (asset === undefined) throw new Error(`The release has no ${name}.`);
      const expected = /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? '')?.[1];
      if (expected === undefined) throw new Error(`GitHub lists no checksum for ${name}.`);
      fs.rmSync(this.work, { recursive: true, force: true });
      fs.mkdirSync(this.work, { recursive: true });
      const zip = path.join(this.work, name);
      this.set({ kind: 'downloading', update, receivedBytes: 0, totalBytes: asset.size });
      const actual = await this.fetchTo(asset.browser_download_url, zip, (receivedBytes) =>
        this.set({ kind: 'downloading', update, receivedBytes, totalBytes: asset.size })
      );
      if (actual !== expected) throw new Error(`${name} did not match its checksum. Nothing was installed.`);
      const unpacked = path.join(this.work, 'unpacked');
      await run('/usr/bin/ditto', ['-x', '-k', zip, unpacked]);
      fs.rmSync(zip, { force: true });
      const bundle = fs.readdirSync(unpacked).find((entry) => entry.endsWith('.app'));
      if (bundle === undefined) throw new Error(`${name} holds no app.`);
      const staged = path.join(unpacked, bundle);
      const plist = path.join(staged, 'Contents', 'Info.plist');
      const read = async (key: string): Promise<string> =>
        (await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist])).stdout.trim();
      if (
        (await read('CFBundleIdentifier')) !== BUNDLE_ID ||
        (await read('CFBundleShortVersionString')) !== update.version
      ) {
        throw new Error(`${name} is not agenterm ${update.version}.`);
      }
      this.staged = staged;
      this.set({ kind: 'ready', update });
    } catch (error) {
      fs.rmSync(this.work, { recursive: true, force: true });
      this.set({ kind: 'error', message: messageOf(error), update });
    }
    return this.status();
  }

  /** Stream a URL to a file, reporting progress; resolves to the file's sha256. */
  private async fetchTo(url: string, file: string, progress: (receivedBytes: number) => void): Promise<string> {
    const response = await fetch(url, { headers: { 'user-agent': `agenterm/${app.getVersion()}` } });
    if (!response.ok || response.body === null) throw new Error(`The download failed: ${response.status}.`);
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(file);
    const reader = response.body.getReader();
    let received = 0;
    let reported = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        received += value.length;
        if (!out.write(value)) await new Promise((resolve) => out.once('drain', resolve));
        if (Date.now() - reported > 150) {
          reported = Date.now();
          progress(received);
        }
      }
    } finally {
      await new Promise((resolve) => out.end(resolve));
    }
    return hash.digest('hex');
  }

  /** Swap in the downloaded app once this one quits; with relaunch, quit now and open the new one. */
  install(relaunch: boolean): void {
    if (this.installing || this.staged === null || this.state.kind !== 'ready') return;
    this.installing = true;
    const script = path.join(this.work, 'install.sh');
    fs.writeFileSync(script, INSTALL_SCRIPT, { mode: 0o755 });
    const args = [script, String(process.pid), appBundle(), this.staged, path.join(this.work, 'previous.app')];
    spawn('/bin/sh', [...args, relaunch ? '1' : '0'], { detached: true, stdio: 'ignore' }).unref();
    if (relaunch) app.quit();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
