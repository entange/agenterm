import { describe, expect, it } from 'vitest';
import { compareVersions, entriesBetween, newestRelease, parseChangelog, type GithubRelease } from './update.js';

const CHANGELOG = `# Changelog

Intro.

## 0.5.0 · 2026-11-02

- Faster.
- A long change that wraps
  onto a second line.

## 0.4.0 - 2026-10-17

- Updates itself.

## Unreleased notes

- not a version

## 0.3.2

- Data folder.
`;

describe('parseChangelog', () => {
  it('reads versions, dates, and wrapped bullets', () => {
    expect(parseChangelog(CHANGELOG)).toEqual([
      { version: '0.5.0', date: '2026-11-02', changes: ['Faster.', 'A long change that wraps onto a second line.'] },
      { version: '0.4.0', date: '2026-10-17', changes: ['Updates itself.'] },
      { version: '0.3.2', date: null, changes: ['Data folder.'] }
    ]);
  });

  it('keeps what lies between two versions, newest first', () => {
    expect(entriesBetween(parseChangelog(CHANGELOG), '0.3.2', '0.5.0').map((entry) => entry.version)).toEqual([
      '0.5.0',
      '0.4.0'
    ]);
    expect(entriesBetween(parseChangelog(CHANGELOG), '0.4.0', '0.4.0')).toEqual([]);
  });
});

describe('newestRelease', () => {
  const release = (tag: string, patch: Partial<GithubRelease> = {}): GithubRelease => ({
    tag_name: tag,
    html_url: `https://github.com/entange/agenterm/releases/tag/${tag}`,
    draft: false,
    prerelease: false,
    assets: [],
    ...patch
  });

  it('picks the highest published version above this one', () => {
    const list = [
      release('v0.4.0'),
      release('v0.10.0'),
      release('v0.11.0', { draft: true }),
      release('v0.12.0', { prerelease: true }),
      release('nightly'),
      release('v0.3.2')
    ];
    expect(newestRelease(list, '0.3.2')?.tag_name).toBe('v0.10.0');
    expect(newestRelease(list, '0.10.0')).toBeNull();
  });

  it('compares numerically', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.3.2', '0.4.0')).toBeLessThan(0);
  });
});
