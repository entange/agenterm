import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';

/** Debounced file change inside a watched cwd. */
export interface WatchedChange {
  sessionId: string;
  path: string;
  change: 'added' | 'modified' | 'deleted';
}

/** Heavy directories skipped by every watcher, matched per path segment. */
export const WATCH_IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.turbo']);

/**
 * Ignore predicate for chokidar. Chokidar 4+ dropped glob support, so
 * ignores match on path segments relative to the watched root.
 */
export function isIgnoredPath(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  if (relative.length === 0 || relative.startsWith('..')) return false;
  if (relative.endsWith('.log')) return true;
  return relative.split(path.sep).some((segment) => WATCH_IGNORED_DIRS.has(segment));
}

/**
 * Per-session file watcher.
 *
 * One chokidar instance per tracked cwd with heavy ignores, no initial
 * scan events, and per-path debounce so save bursts emit once. Changes
 * fan out through the callback; the server turns them into file.changed
 * events. Never throws out of callbacks.
 */
export class FileWatch {
  private readonly watchers = new Map<string, { watcher: FSWatcher; sessionIds: Set<string> }>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly debounceMs: number;
  private readonly onChange: ((change: WatchedChange) => void) | undefined;

  constructor(
    options: {
      debounceMs?: number | undefined;
      onChange?: ((change: WatchedChange) => void) | undefined;
    } = {}
  ) {
    this.debounceMs = options.debounceMs ?? 500;
    this.onChange = options.onChange;
  }

  /** Track a session cwd. Shares one watcher per distinct cwd. */
  track(sessionId: string, cwd: string): void {
    const existing = this.watchers.get(cwd);
    if (existing !== undefined) {
      existing.sessionIds.add(sessionId);
      return;
    }
    let watcher: FSWatcher;
    try {
      watcher = chokidar.watch(cwd, {
        ignored: (file: string) => isIgnoredPath(cwd, file),
        ignoreInitial: true,
        depth: 6,
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
      });
    } catch {
      return;
    }
    const entry = { watcher, sessionIds: new Set([sessionId]) };
    this.watchers.set(cwd, entry);
    const emit = (file: string, change: WatchedChange['change']): void => {
      for (const id of entry.sessionIds) {
        this.debounced({ sessionId: id, path: file, change });
      }
    };
    watcher.on('add', (file) => emit(file, 'added'));
    watcher.on('change', (file) => emit(file, 'modified'));
    watcher.on('unlink', (file) => emit(file, 'deleted'));
    watcher.on('error', () => undefined);
  }

  private debounced(change: WatchedChange): void {
    const key = `${change.sessionId}\n${change.path}`;
    const pending = this.timers.get(key);
    if (pending !== undefined) clearTimeout(pending);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        try {
          this.onChange?.(change);
        } catch {
          // Watcher callbacks never break the loop.
        }
      }, this.debounceMs)
    );
  }

  /** Stop tracking one session, closing idle cwd watchers. */
  untrack(sessionId: string): void {
    for (const [key, timer] of this.timers) {
      if (key.startsWith(`${sessionId}\n`)) {
        clearTimeout(timer);
        this.timers.delete(key);
      }
    }
    for (const [cwd, entry] of this.watchers) {
      entry.sessionIds.delete(sessionId);
      if (entry.sessionIds.size === 0) {
        void entry.watcher.close().catch(() => undefined);
        this.watchers.delete(cwd);
      }
    }
  }

  /** Watched cwd count. Used by tests. */
  watcherCount(): number {
    return this.watchers.size;
  }

  async close(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const entry of this.watchers.values()) {
      await entry.watcher.close().catch(() => undefined);
    }
    this.watchers.clear();
  }
}
