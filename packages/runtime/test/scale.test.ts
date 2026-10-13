import { describe, expect, it } from 'vitest';
import { headers, rig } from './helpers.js';

describe('sessions at scale', () => {
  it('links a session to the session that started it', async () => {
    const r = rig();
    const parent = await r.spawn({ title: 'lead agent' });
    const child = (await r.spawn({ title: 'helper', parentSessionId: parent.id })) as { id: string };
    expect(r.store.get(child.id)?.parentSessionId).toBe(parent.id);
    const orphan = (await r.spawn({ parentSessionId: '00000000-0000-0000-0000-000000000000' })) as { id: string };
    expect(r.store.get(orphan.id)?.parentSessionId).toBe(null);
    const bad = await r.app.inject({
      method: 'POST',
      url: '/sessions',
      headers,
      payload: { provider: 'generic', command: '/bin/echo', cwd: '/tmp', parentSessionId: 'nope' }
    });
    expect(bad.statusCode).toBe(400);
  });

  it('does not flag sub-sessions sharing their parent folder as a collision', async () => {
    const r = rig();
    const lead = await r.spawn({ title: 'lead agent' });
    await r.spawn({ title: 'helper 1', parentSessionId: lead.id });
    const helper = (await r.spawn({ title: 'helper 2', parentSessionId: lead.id })) as { id: string };
    await r.spawn({ title: 'grandchild', parentSessionId: helper.id });
    expect(r.seen.filter((event) => event.kind === 'workspace.conflict')).toHaveLength(0);
    await r.spawn({ title: 'unrelated agent' });
    expect(r.seen.filter((event) => event.kind === 'workspace.conflict')).toHaveLength(1);
  });

  it('frees an ended session ring once its log is on disk, and still serves scrollback', async () => {
    const r = rig();
    const session = await r.spawn();
    r.last()?.emitData('kept on disk\r\n');
    r.last()?.emitExit(0);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(r.pty.get(session.id)?.log.isReleased()).toBe(true);
    const res = await r.app.inject({ method: 'GET', url: `/sessions/${session.id}/output`, headers });
    const body = res.json() as { chunks: Array<{ data: string }>; live: boolean };
    expect(body.live).toBe(false);
    expect(body.chunks[0]?.data).toBe('kept on disk\r\n');
    const search = await r.app.inject({ method: 'GET', url: '/search?q=kept%20on', headers });
    expect((search.json() as { matches: unknown[] }).matches).toHaveLength(1);
  });

  it('handles hundreds of sessions without slowing the list', async () => {
    const r = rig();
    for (let i = 0; i < 300; i++) await r.spawn({ title: `s${i}` });
    const started = performance.now();
    const res = await r.app.inject({ method: 'GET', url: '/sessions', headers });
    expect((res.json() as { sessions: unknown[] }).sessions).toHaveLength(300);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
