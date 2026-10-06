import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentermEvent } from '@agenterm/core';
import { EventBus } from '../src/events.js';
import { addGrant } from '../src/grants.js';
import { HarnessWatch, type AccessLog } from '../src/harnessWatch.js';
import { SessionStore } from '../src/sessionStore.js';

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agenterm-watch-'));
}

function rig(dataDir: string) {
  const store = new SessionStore();
  const bus = new EventBus();
  const seen: AgentermEvent[] = [];
  bus.onEvent((event) => seen.push(event));
  const accesses: AccessLog[] = [];
  const watch = new HarnessWatch({
    enabled: true,
    dataDir,
    store,
    bus,
    onAccess: (entry) => accesses.push(entry)
  });
  return { store, bus, seen, accesses, watch };
}

function trackClaude(store: SessionStore, watch: HarnessWatch): string {
  const record = store.createSpawned({
    provider: 'claude',
    agentId: 'agent-1',
    title: 'watched',
    cwd: '/tmp',
    worktreeRoot: null,
    branch: null,
    commandLine: ['claude'],
    resolvedBinaryPath: '/usr/local/bin/claude',
    pid: 4242,
    cols: 80,
    rows: 24
  });
  watch.track(record.id);
  return record.id;
}

describe('HarnessWatch with fixtures', () => {
  it('maps a permission transcript to waiting_permission with an event', async () => {
    const dataDir = scratch();
    const home = path.join(scratch(), 'fakehome');
    // Real layout: one folder per project, named after its cwd (/tmp → -tmp).
    fs.mkdirSync(path.join(home, 'projects', '-tmp'), { recursive: true });
    fs.writeFileSync(
      path.join(home, 'projects', '-tmp', 'work.jsonl'),
      `${JSON.stringify({ version: '1', kind: 'permission_prompt', text: 'Tool needs approval to edit src/auth.ts' })}\n`
    );
    addGrant(dataDir, 'claude', home);
    const { store, seen, accesses, watch } = rig(dataDir);
    const id = trackClaude(store, watch);
    await watch.poll();
    expect(store.get(id)?.overlay).toBe('waiting_permission');
    expect(store.get(id)?.overlaySource).toBe('harness');
    const status = seen.filter((event) => event.kind === 'agent.status');
    expect(status).toHaveLength(1);
    expect(accesses.length).toBeGreaterThan(0);
    expect(accesses.every((entry) => entry.path.startsWith(home))).toBe(true);
    watch.stop();
  });

  it('yields unknown on garbage transcripts without throwing', async () => {
    const dataDir = scratch();
    const home = path.join(scratch(), 'fakehome');
    fs.mkdirSync(path.join(home, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(home, 'projects', 'junk.jsonl'), 'this is not structured\n');
    addGrant(dataDir, 'claude', home);
    const { store, seen, watch } = rig(dataDir);
    const id = trackClaude(store, watch);
    await watch.poll();
    expect(store.get(id)?.overlay).toBe('unknown');
    expect(seen.filter((event) => event.kind === 'agent.status')).toHaveLength(0);
    watch.stop();
  });

  it('reads nothing and changes nothing when disabled', async () => {
    const dataDir = scratch();
    const home = path.join(scratch(), 'fakehome');
    fs.mkdirSync(path.join(home, 'projects'), { recursive: true });
    fs.writeFileSync(
      path.join(home, 'projects', 'work.jsonl'),
      `${JSON.stringify({ version: '1', kind: 'permission_prompt', text: 'approve this' })}\n`
    );
    addGrant(dataDir, 'claude', home);
    const store = new SessionStore();
    const bus = new EventBus();
    const seen: AgentermEvent[] = [];
    bus.onEvent((event) => seen.push(event));
    const watch = new HarnessWatch({ enabled: false, dataDir, store, bus });
    const id = trackClaude(store, watch);
    await watch.poll();
    expect(store.get(id)?.overlay).toBe('unknown');
    expect(seen).toHaveLength(0);
    watch.stop();
  });

  it('leaves sessions alone with no grants', async () => {
    const dataDir = scratch();
    const { store, seen, watch } = rig(dataDir);
    const id = trackClaude(store, watch);
    await watch.poll();
    expect(store.get(id)?.overlay).toBe('unknown');
    expect(seen).toHaveLength(0);
    watch.stop();
  });

  it('never touches exited sessions', async () => {
    const dataDir = scratch();
    const home = path.join(scratch(), 'fakehome');
    fs.mkdirSync(path.join(home, 'projects'), { recursive: true });
    fs.writeFileSync(
      path.join(home, 'projects', 'work.jsonl'),
      `${JSON.stringify({ version: '1', kind: 'permission_prompt', text: 'approve this' })}\n`
    );
    addGrant(dataDir, 'claude', home);
    const { store, watch } = rig(dataDir);
    const id = trackClaude(store, watch);
    store.markExited(id, 0, null);
    await watch.poll();
    expect(store.get(id)?.overlay).toBe('unknown');
    watch.stop();
  });
});

describe('claude adapter project scoping', () => {
  it('reads only the transcript folder of the session cwd', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { claudeAdapter, claudeProjectSlug } = await import('../src/adapters/claude.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenterm-claude-root-'));
    const mine = path.join(root, 'projects', claudeProjectSlug('/work/app.v2'));
    const other = path.join(root, 'projects', claudeProjectSlug('/work/other'));
    fs.mkdirSync(mine, { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(mine, 'a.jsonl'), '{}\n');
    fs.writeFileSync(path.join(other, 'b.jsonl'), '{}\n');
    expect(claudeProjectSlug('/work/app.v2')).toBe('-work-app-v2');
    expect(claudeAdapter.discoverFiles([root], '/work/app.v2').map((file) => path.basename(file))).toEqual(['a.jsonl']);
    expect(claudeAdapter.discoverFiles([root], '/work/none')).toEqual([]);
  });
});
