import type { SessionRecord } from '@agenterm/core';
import { ATTENTION_ORDER, type Attention, type AttentionGroup } from '../../shared/attention.js';
import { callsign } from '../../shared/callsign.js';
import type { GroupBy } from './ui.js';

export const GROUP_LABELS: Record<AttentionGroup, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  quiet: 'Quiet',
  ended: 'Ended'
};

/** Ended sessions shown before "show more" in status grouping. */
export const ENDED_PREVIEW = 8;

/** Deepest nesting drawn for sessions started by other sessions. */
const MAX_DEPTH = 3;

export type BoardRow =
  | {
      kind: 'group';
      key: string;
      label: string;
      title: string;
      /** Status grouping: the group itself. Project grouping: null. */
      group: AttentionGroup | null;
      count: number;
      needsYou: number;
      working: number;
      collapsed: boolean;
    }
  | { kind: 'session'; session: SessionRecord; depth: number; children: number; collapsed: boolean }
  | { kind: 'more'; key: string; hidden: number };

/** Folder a session belongs to on the board: its git worktree, else its cwd. */
export function projectKey(session: SessionRecord): string {
  return session.worktreeRoot ?? session.cwd;
}

function folderLabel(dir: string): string {
  const parts = dir.split(/[\\/]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? dir;
}

/** Every filter term must appear in title, callsign, folder, branch, or provider. */
export function matchesFilter(session: SessionRecord, filter: string): boolean {
  const terms = filter
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
  if (terms.length === 0) return true;
  const haystack = [session.title, callsign(session), session.cwd, session.branch ?? '', session.provider]
    .join(' ')
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

const GROUP_RANK = new Map(ATTENTION_ORDER.map((group, index) => [group, index]));

function rank(attention: Map<string, Attention>, session: SessionRecord): number {
  return GROUP_RANK.get(attention.get(session.id)?.group ?? 'quiet') ?? 2;
}

/**
 * Order members so sessions started by another session follow their parent,
 * indented. Collapsed parents hide their descendants. Orphans (parent in a
 * different group or closed) stay at the top level.
 */
function nest(members: SessionRecord[], collapsed: ReadonlySet<string>): BoardRow[] {
  const ids = new Set(members.map((session) => session.id));
  const children = new Map<string, SessionRecord[]>();
  const roots: SessionRecord[] = [];
  for (const session of members) {
    const parent = session.parentSessionId;
    if (parent !== null && ids.has(parent) && parent !== session.id) {
      const list = children.get(parent) ?? [];
      list.push(session);
      children.set(parent, list);
    } else {
      roots.push(session);
    }
  }
  const out: BoardRow[] = [];
  const visit = (session: SessionRecord, depth: number, seen: Set<string>): void => {
    if (seen.has(session.id)) return;
    seen.add(session.id);
    const kids = children.get(session.id) ?? [];
    const key = `parent:${session.id}`;
    const isCollapsed = collapsed.has(key);
    out.push({ kind: 'session', session, depth, children: kids.length, collapsed: isCollapsed });
    if (isCollapsed) {
      hide(session.id, seen);
      return;
    }
    for (const kid of kids) visit(kid, Math.min(depth + 1, MAX_DEPTH), seen);
  };
  // Descendants of a collapsed parent count as placed, so the orphan pass below skips them.
  const hide = (id: string, seen: Set<string>): void => {
    for (const kid of children.get(id) ?? []) {
      if (seen.has(kid.id)) continue;
      seen.add(kid.id);
      hide(kid.id, seen);
    }
  };
  const seen = new Set<string>();
  for (const root of roots) visit(root, 0, seen);
  // Cycles in parent links would leave members unvisited; show them flat.
  for (const session of members) if (!seen.has(session.id)) visit(session, 0, seen);
  return out;
}

/**
 * Flat row model for the virtualized sidebar. Status grouping follows the
 * board order (Needs you first). Project grouping puts folders with sessions
 * that need you first, then the most recently started folders.
 */
export function buildRows(
  sessions: SessionRecord[],
  attention: Map<string, Attention>,
  options: { groupBy: GroupBy; collapsed: ReadonlySet<string>; filter: string; showAllEnded: boolean }
): BoardRow[] {
  const visible = sessions.filter((session) => matchesFilter(session, options.filter));
  const sorted = [...visible].sort((a, b) => rank(attention, a) - rank(attention, b) || b.startedAtMs - a.startedAtMs);
  const rows: BoardRow[] = [];
  const groupOf = (members: SessionRecord[]) => ({
    needsYou: members.filter((session) => attention.get(session.id)?.group === 'needs-you').length,
    working: members.filter((session) => attention.get(session.id)?.group === 'working').length
  });

  if (options.groupBy === 'status') {
    for (const group of ATTENTION_ORDER) {
      const members = sorted.filter((session) => (attention.get(session.id)?.group ?? 'quiet') === group);
      if (members.length === 0) continue;
      const key = `group:${group}`;
      const collapsed = options.collapsed.has(key);
      rows.push({
        kind: 'group',
        key,
        label: GROUP_LABELS[group],
        title: GROUP_LABELS[group],
        group,
        count: members.length,
        collapsed,
        ...groupOf(members)
      });
      if (collapsed) continue;
      const nested = nest(members, options.collapsed);
      const limit = group === 'ended' && !options.showAllEnded ? ENDED_PREVIEW : nested.length;
      rows.push(...nested.slice(0, limit));
      if (nested.length > limit) rows.push({ kind: 'more', key: 'more:ended', hidden: nested.length - limit });
    }
    return rows;
  }

  const byProject = new Map<string, SessionRecord[]>();
  for (const session of sorted) {
    const key = projectKey(session);
    const list = byProject.get(key) ?? [];
    list.push(session);
    byProject.set(key, list);
  }
  const projects = [...byProject.entries()].sort(([, a], [, b]) => {
    const needs = groupOf(b).needsYou - groupOf(a).needsYou;
    if (needs !== 0) return needs;
    return Math.max(...b.map((s) => s.startedAtMs)) - Math.max(...a.map((s) => s.startedAtMs));
  });
  for (const [dir, members] of projects) {
    const key = `project:${dir}`;
    const collapsed = options.collapsed.has(key);
    rows.push({
      kind: 'group',
      key,
      label: folderLabel(dir),
      title: dir,
      group: null,
      count: members.length,
      collapsed,
      ...groupOf(members)
    });
    if (!collapsed) rows.push(...nest(members, options.collapsed));
  }
  return rows;
}
