import { describe, expect, it } from 'vitest';
import { AgentHooks } from '../src/agentHooks.js';
import { parseOtlpLogs, UsageLedger } from '../src/usage.js';
import { headers, rig } from './helpers.js';

function apiRequest(cost: number | string, input: number, output: number) {
  return {
    resourceLogs: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }] },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: '1',
                body: { stringValue: 'claude_code.api_request' },
                attributes: [
                  { key: 'event.name', value: { stringValue: 'api_request' } },
                  { key: 'model', value: { stringValue: 'claude-opus-5-5' } },
                  { key: 'cost_usd', value: typeof cost === 'number' ? { doubleValue: cost } : { stringValue: cost } },
                  { key: 'input_tokens', value: { intValue: String(input) } },
                  { key: 'output_tokens', value: { intValue: output } }
                ]
              },
              { body: { stringValue: 'claude_code.tool_result' }, attributes: [] }
            ]
          }
        ]
      }
    ]
  };
}

describe('OTLP usage', () => {
  it('parses api_request events from JSON-encoded OTLP logs', () => {
    const events = parseOtlpLogs(apiRequest(0.0125, 1200, 340));
    expect(events.map((event) => event.name)).toEqual(['api_request', 'tool_result']);
    expect(events[0]?.attributes['input_tokens']).toBe(1200);
    expect(parseOtlpLogs(null)).toEqual([]);
    expect(parseOtlpLogs({ resourceLogs: [{ scopeLogs: 'x' }] })).toEqual([]);
  });

  it('accumulates cost and tokens per session', () => {
    const ledger = new UsageLedger(() => 42);
    expect(ledger.apply('s', parseOtlpLogs(apiRequest(0.01, 100, 10)))).toBe(true);
    ledger.apply('s', parseOtlpLogs(apiRequest('0.02', 200, 20)));
    expect(ledger.get('s')).toMatchObject({
      costUsd: 0.03,
      inputTokens: 300,
      outputTokens: 30,
      requests: 2,
      model: 'claude-opus-5-5',
      updatedAtMs: 42
    });
    expect(ledger.apply('s', parseOtlpLogs({ resourceLogs: [] }))).toBe(false);
  });

  it('points Claude telemetry at the daemon unless the user configured OTEL', () => {
    const hooks = new AgentHooks({ port: 4000 });
    const fresh = hooks.prepare({ sessionId: 'a', provider: 'claude', args: [], requested: true, env: {} });
    expect(fresh.env['OTEL_EXPORTER_OTLP_LOGS_ENDPOINT']).toBe('http://127.0.0.1:4000/otel/a/v1/logs');
    expect(fresh.env['CLAUDE_CODE_ENABLE_TELEMETRY']).toBe('1');
    const mine = hooks.prepare({
      sessionId: 'b',
      provider: 'claude',
      args: [],
      requested: true,
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector' }
    });
    expect(mine.env).toEqual({});
    expect(hooks.prepare({ sessionId: 'c', provider: 'codex', args: [], requested: true }).env).toEqual({});
  });

  it('accepts telemetry only with the session token and serves totals', async () => {
    const hooks = new AgentHooks({ port: 37241 });
    const r = rig({ hooks });
    const session = await r.spawn({ provider: 'claude', command: '/bin/echo' });
    const env = r.last()?.spawnEnv ?? {};
    const token = (env['OTEL_EXPORTER_OTLP_LOGS_HEADERS'] ?? '').replace('x-agenterm-token=', '');
    expect(token.length).toBe(48);
    const denied = await r.app.inject({
      method: 'POST',
      url: `/otel/${session.id}/v1/logs`,
      headers,
      payload: apiRequest(1, 1, 1)
    });
    expect(denied.statusCode).toBe(401);
    const ok = await r.app.inject({
      method: 'POST',
      url: `/otel/${session.id}/v1/logs`,
      headers: { 'x-agenterm-token': token },
      payload: apiRequest(0.5, 1000, 50)
    });
    expect(ok.statusCode).toBe(200);
    await r.app.inject({
      method: 'POST',
      url: `/otel/${session.id}/v1/metrics`,
      headers: { 'x-agenterm-token': token },
      payload: {}
    });
    const totals = await r.app.inject({ method: 'GET', url: '/usage', headers });
    expect((totals.json() as { sessions: Record<string, { costUsd: number }> }).sessions[session.id]?.costUsd).toBe(
      0.5
    );
    expect(r.seen.some((event) => event.kind === 'session.usage')).toBe(true);
    const stored = await r.app.inject({ method: 'GET', url: `/events?sessionId=${session.id}`, headers });
    expect(
      (stored.json() as { events: Array<{ kind: string }> }).events.some((event) => event.kind === 'session.usage')
    ).toBe(false);
  });
});
