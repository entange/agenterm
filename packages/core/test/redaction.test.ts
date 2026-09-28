import { describe, expect, it } from 'vitest';
import { isSecretEnvKey, redactEnvForLog, redactText, stripSecretEnv } from '../src/redaction.js';

describe('secret env blocklist', () => {
  it('flags key-like names', () => {
    expect(isSecretEnvKey('OPENAI_API_KEY')).toBe(true);
    expect(isSecretEnvKey('GH_TOKEN')).toBe(true);
    expect(isSecretEnvKey('MY_SECRET')).toBe(true);
    expect(isSecretEnvKey('DB_PASSWORD')).toBe(true);
    expect(isSecretEnvKey('DATABASE_URL')).toBe(true);
    expect(isSecretEnvKey('AWS_REGION')).toBe(true);
    expect(isSecretEnvKey('ANTHROPIC_KEY')).toBe(true);
  });

  it('allows safe keys', () => {
    expect(isSecretEnvKey('PATH')).toBe(false);
    expect(isSecretEnvKey('TERM')).toBe(false);
    expect(isSecretEnvKey('AGENTERM_SESSION_ID')).toBe(false);
  });

  it('strips secrets from env maps', () => {
    const out = stripSecretEnv({ PATH: '/usr/bin', OPENAI_API_KEY: 'x', TERM: 'y' });
    expect(out).toEqual({ PATH: '/usr/bin', TERM: 'y' });
  });

  it('masks secret values for logs', () => {
    const out = redactEnvForLog({ PATH: '/usr/bin', GH_TOKEN: 'secret-value' });
    expect(out['PATH']).toBe('/usr/bin');
    expect(out['GH_TOKEN']).toBe('[REDACTED]');
  });
});

describe('redactText', () => {
  it('masks token shapes', () => {
    expect(redactText('key sk-abcdefgh12345678 end')).toContain('[REDACTED]');
    expect(redactText('token ghp_abcdefgh12345678 end')).toContain('[REDACTED]');
    expect(redactText('auth Bearer abcdefgh12345678 end')).toContain('[REDACTED]');
  });

  it('leaves plain text alone', () => {
    expect(redactText('hello world')).toBe('hello world');
  });

  it('never throws on odd input', () => {
    expect(redactText(null)).toBe('');
    expect(redactText(42)).toBe('');
    expect(redactText(undefined)).toBe('');
  });
});
