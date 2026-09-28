import { describe, expect, it } from 'vitest';
import {
  parseClaudeHarnessPayload,
  parseCodexHarnessPayload,
  parseGeminiHarnessPayload,
  parseHarnessPayload,
  parseOpencodeHarnessPayload
} from '../src/harness.js';
import claudePermission from './fixtures/claude-permission.json';
import claudeUnknownShape from './fixtures/claude-unknown-shape.json';
import claudeVersionMismatch from './fixtures/claude-version-mismatch.json';
import codexWorking from './fixtures/codex-working.json';

describe('claude harness', () => {
  it('maps permission prompts', () => {
    const out = parseClaudeHarnessPayload(claudePermission);
    expect(out.overlay).toBe('waiting_permission');
  });

  it('yields unknown on version mismatch without throwing', () => {
    const out = parseClaudeHarnessPayload(claudeVersionMismatch);
    expect(out.overlay).toBe('unknown');
  });

  it('yields unknown on odd shape without throwing', () => {
    const out = parseClaudeHarnessPayload(claudeUnknownShape);
    expect(out.overlay).toBe('unknown');
  });

  it('never throws on null', () => {
    expect(() => parseClaudeHarnessPayload(null)).not.toThrow();
    expect(parseClaudeHarnessPayload(null).overlay).toBe('unknown');
  });

  it('redacts summaries', () => {
    const out = parseClaudeHarnessPayload({
      version: '1',
      kind: 'permission',
      text: 'needs approval Bearer abcdefgh12345678'
    });
    expect(out.summary ?? '').toContain('[REDACTED]');
  });
});

describe('codex and opencode harness', () => {
  it('maps working status', () => {
    expect(parseCodexHarnessPayload(codexWorking).overlay).toBe('working');
  });

  it('yields unknown on mismatch', () => {
    expect(parseCodexHarnessPayload({ hello: 1 }).overlay).toBe('unknown');
    expect(parseOpencodeHarnessPayload(undefined).overlay).toBe('unknown');
  });

  it('never throws', () => {
    expect(() => parseCodexHarnessPayload(Symbol('x') as unknown)).not.toThrow();
  });
});

describe('gemini harness', () => {
  it('always yields unknown until a path is confirmed', () => {
    expect(parseGeminiHarnessPayload({ status: 'working' }).overlay).toBe('unknown');
  });
});

describe('dispatch', () => {
  it('routes by provider and never throws', () => {
    expect(parseHarnessPayload('claude', claudePermission).overlay).toBe('waiting_permission');
    expect(parseHarnessPayload('gemini', {}).overlay).toBe('unknown');
    expect(() => parseHarnessPayload('codex', null)).not.toThrow();
  });
});
