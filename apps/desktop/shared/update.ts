/** One version's entry in CHANGELOG.md. */
export interface ChangelogEntry {
  version: string;
  /** YYYY-MM-DD, when the heading has one. */
  date: string | null;
  changes: string[];
}

/** A newer release, what changed since this version, and how to get it. */
export interface UpdateInfo {
  version: string;
  /** The release page on GitHub. */
  url: string;
  /** Every version newer than this one, newest first. Empty when the changelog could not be read. */
  entries: ChangelogEntry[];
}

/**
 * Where the updater is.
 * idle: up to date as of checkedAtMs (null before the first check).
 * manual: an update exists but cannot be installed in place, for `reason`;
 * the release page has the DMG.
 */
export type UpdateState =
  | { kind: 'idle'; checkedAtMs: number | null }
  | { kind: 'checking' }
  | { kind: 'available'; update: UpdateInfo }
  | { kind: 'manual'; update: UpdateInfo; reason: string }
  | { kind: 'downloading'; update: UpdateInfo; receivedBytes: number; totalBytes: number }
  | { kind: 'ready'; update: UpdateInfo }
  | { kind: 'error'; message: string; update: UpdateInfo | null };

export interface UpdateStatus {
  /** This app's version. */
  current: string;
  /** False in development builds and on other platforms: nothing to check. */
  enabled: boolean;
  state: UpdateState;
}

/** Compare plain x.y.z versions: negative when a is older. */
export function compareVersions(a: string, b: string): number {
  const parse = (text: string): number[] => text.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const [left, right] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const HEADING = /^## \[?v?(\d+\.\d+\.\d+)\]?(?:\s*[-·—]\s*(\d{4}-\d{2}-\d{2}))?\s*$/;

/**
 * Entries of a changelog written as `## 0.4.0 · 2026-10-17` headings over
 * `- ` bullets. Bullets may wrap onto indented lines.
 */
export function parseChangelog(text: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let current: ChangelogEntry | null = null;
  for (const line of text.split('\n')) {
    const heading = HEADING.exec(line.trim());
    if (heading !== null) {
      current = { version: heading[1] ?? '', date: heading[2] ?? null, changes: [] };
      entries.push(current);
    } else if (line.startsWith('## ')) {
      current = null;
    } else if (current !== null && /^[-*] /.test(line)) {
      current.changes.push(line.slice(2).trim());
    } else if (current !== null && /^\s+\S/.test(line) && current.changes.length > 0) {
      current.changes[current.changes.length - 1] += ` ${line.trim()}`;
    }
  }
  return entries;
}

/** A release as GitHub's API lists it, trimmed to what the updater reads. */
export interface GithubRelease {
  tag_name: string;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  assets: Array<{ name: string; browser_download_url: string; size: number; digest?: string | null }>;
}

/** The newest published release above `current`, or null when this is the newest. */
export function newestRelease(releases: GithubRelease[], current: string): GithubRelease | null {
  let best: GithubRelease | null = null;
  for (const release of releases) {
    if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) continue;
    const version = release.tag_name.slice(1);
    if (compareVersions(version, current) <= 0) continue;
    if (best === null || compareVersions(version, best.tag_name.slice(1)) > 0) best = release;
  }
  return best;
}

/** Changelog entries newer than `current` and no newer than `latest`, newest first. */
export function entriesBetween(entries: ChangelogEntry[], current: string, latest: string): ChangelogEntry[] {
  return entries
    .filter((entry) => compareVersions(entry.version, current) > 0 && compareVersions(entry.version, latest) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version));
}
