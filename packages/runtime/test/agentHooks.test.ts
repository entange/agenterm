import { execFile, spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { AgentHooks, claudeHookStatus, codexNotifyStatus } from '../src/agentHooks.js';
import { headers, rig } from './helpers.js';

const run = promisify(execFile);
const SESSION = '11111111-2222-3333-4444-555555555555';

describe('hook payload mapping', () => {
  it('maps Claude Code hook events to statuses', () => {
    expect(claudeHookStatus({ hook_event_name: 'UserPromptSubmit', prompt: 'fix the  login\nflow' })).toEqual({
      overlay: 'working',
      summary: 'fix the login flow'
    });
    expect(claudeHookStatus({ hook_event_name: 'PostToolUse', tool_name: 'Bash' })?.summary).toBe('Using Bash');
    expect(
      claudeHookStatus({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' })
        ?.overlay
    ).toBe('waiting_permission');
    expect(
      claudeHookStatus({ hook_event_name: 'Notification', message: 'Claude is waiting for your input' })?.overlay
    ).toBe('waiting_input');
    expect(claudeHookStatus({ hook_event_name: 'Stop' })?.overlay).toBe('waiting_input');
    expect(claudeHookStatus({ hook_event_name: 'Mystery' })).toBe(null);
    expect(claudeHookStatus('nope')).toBe(null);
  });

  it('maps Codex turn completion and redacts summaries', () => {
    expect(
      codexNotifyStatus({ type: 'agent-turn-complete', 'last-assistant-message': 'used sk-abcdefghijklmnop' })
    ).toEqual({
      overlay: 'waiting_input',
      summary: 'used [REDACTED]'
    });
    expect(codexNotifyStatus({ type: 'other' })).toBe(null);
  });
});

describe('AgentHooks.prepare', () => {
  it('adds Claude hooks via --settings and Codex notify via -c, never for generic', () => {
    const hooks = new AgentHooks({ port: 1234 });
    const claude = hooks.prepare({
      sessionId: SESSION,
      provider: 'claude',
      args: ['--model', 'opus'],
      requested: true
    });
    expect(claude.installed).toBe(true);
    expect(claude.args[0]).toBe('--settings');
    const settings = JSON.parse(claude.args[1] ?? '{}') as { hooks: Record<string, unknown> };
    expect(Object.keys(settings.hooks)).toEqual([
      'UserPromptSubmit',
      'PostToolUse',
      'Notification',
      'Stop',
      'SessionEnd'
    ]);
    expect(claude.args.slice(2)).toEqual(['--model', 'opus']);
    const codex = hooks.prepare({ sessionId: SESSION, provider: 'codex', args: [], requested: true });
    expect(codex.args[0]).toBe('-c');
    expect(codex.args[1]).toMatch(/^notify=\["curl", /);
    expect(hooks.prepare({ sessionId: SESSION, provider: 'generic', args: ['x'], requested: true })).toEqual({
      args: ['x'],
      installed: false
    });
  });

  it('respects user settings, opt-out, and the global switch', () => {
    const hooks = new AgentHooks({ port: 1 });
    expect(
      hooks.prepare({ sessionId: SESSION, provider: 'claude', args: ['--settings', 'x.json'], requested: true })
        .installed
    ).toBe(false);
    expect(
      hooks.prepare({ sessionId: SESSION, provider: 'codex', args: ['-c', 'notify=["x"]'], requested: true }).installed
    ).toBe(false);
    expect(hooks.prepare({ sessionId: SESSION, provider: 'claude', args: [], requested: false }).installed).toBe(false);
    const off = new AgentHooks({ port: 1, enabled: false });
    expect(off.prepare({ sessionId: SESSION, provider: 'claude', args: [], requested: true }).installed).toBe(false);
  });
});

describe.skipIf(spawnSync('curl', ['--version']).status !== 0)('ingest end to end', () => {
  async function listening() {
    const hooks = new AgentHooks({ port: 0 });
    const r = rig({ hooks });
    await r.app.listen({ host: '127.0.0.1', port: 0 });
    hooks.setPort((r.app.server.address() as AddressInfo).port);
    return r;
  }

  it('runs the generated Claude hook command and applies its status', async () => {
    const r = await listening();
    try {
      const session = await r.spawn({ provider: 'claude', command: '/bin/echo' });
      const args = r.last()?.spawnArgs ?? [];
      const settings = JSON.parse(args[1] ?? '{}') as {
        hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      };
      const command = settings.hooks['Notification']?.[0]?.hooks[0]?.command ?? '';
      await new Promise<void>((resolve, reject) => {
        const child = execFile('/bin/sh', ['-c', command], (error) => (error === null ? resolve() : reject(error)));
        child.stdin?.end(
          JSON.stringify({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' })
        );
      });
      expect(r.store.get(session.id)?.overlay).toBe('waiting_permission');
      expect(r.store.get(session.id)?.overlaySource).toBe('hooks');
      expect(r.store.get(session.id)?.commandLine).toEqual(['/bin/echo']);
      expect(r.seen.some((event) => event.kind === 'agent.status' && event.overlay === 'waiting_permission')).toBe(
        true
      );

      await r.app.inject({ method: 'POST', url: `/sessions/${session.id}/input`, headers, payload: { data: '1' } });
      expect(r.store.get(session.id)?.overlay).toBe('working');

      const forged = await r.app.inject({
        method: 'POST',
        url: `/ingest/claude/${session.id}`,
        headers: { authorization: `Bearer ${'0'.repeat(48)}` },
        payload: { hook_event_name: 'Stop' }
      });
      expect(forged.statusCode).toBe(401);
      const daemonToken = await r.app.inject({
        method: 'POST',
        url: `/ingest/claude/${session.id}`,
        headers,
        payload: { hook_event_name: 'Stop' }
      });
      expect(daemonToken.statusCode).toBe(401);
    } finally {
      await r.app.close();
    }
  });

  it('runs the generated Codex notify argv and applies its status', async () => {
    const r = await listening();
    try {
      const session = await r.spawn({ provider: 'codex', command: '/bin/echo' });
      const toml = (r.last()?.spawnArgs ?? [])[1] ?? '';
      const argv = JSON.parse(toml.replace(/^notify=/, '')) as string[];
      await run(argv[0] ?? 'curl', [
        ...argv.slice(1),
        JSON.stringify({ type: 'agent-turn-complete', 'last-assistant-message': 'Done.' })
      ]);
      expect(r.store.get(session.id)?.overlay).toBe('waiting_input');
    } finally {
      await r.app.close();
    }
  });
});
