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

  it('flags secret name segments and connection strings', () => {
    for (const key of ['PGPASSWD', 'DB_PASS', 'CREDENTIALS', 'AUTH_COOKIE', 'REDIS_URL', 'MONGO_URI', 'SENTRY_DSN']) {
      expect(isSecretEnvKey(key)).toBe(true);
    }
  });

  it('allows safe keys', () => {
    expect(isSecretEnvKey('KEYBOARD')).toBe(false);
    expect(isSecretEnvKey('PWD')).toBe(false);
    expect(isSecretEnvKey('SSH_AUTH_SOCK')).toBe(false);
    expect(isSecretEnvKey('XDG_SESSION_TYPE')).toBe(false);
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
    expect(redactText('auth Bearer abcdefghijklmnopqrstu end')).not.toContain('abcdefghijklmnopqrstu');
  });

  it('masks common credential formats', () => {
    const secrets = [
      'AKIAIOSFODNN7EXAMPLE',
      'github_pat_11ABCDEFG0123456789_abcdefghijk',
      'ghs_abcdefghijklmnop1234',
      'glpat-abcdefghij1234567890',
      'npm_abcdefghijklmnopqrstuvwxyz0123456789',
      'sk_live_abcdefghijklmnop1234',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----'
    ];
    for (const secret of secrets) expect(redactText(`x ${secret} y`)).toBe('x [REDACTED] y');
    expect(redactText('postgres://user:hunter2@db/x')).toBe('postgres://user:[REDACTED]@db/x');
    expect(redactText('PASSWORD=hunter22 next')).toBe('PASSWORD=[REDACTED] next');
    expect(redactText('{"api_key": "abcd1234efgh"}')).toBe('{"api_key": "[REDACTED]"}');
    expect(redactText('Authorization: Basic dXNlcjpwYXNzd29yZA==')).toBe('Authorization: Basic [REDACTED]');
  });

  it('leaves plain text alone', () => {
    expect(redactText('hello world')).toBe('hello world');
    for (const text of [
      'task-management-system',
      'disk-usage-summary',
      'Bearer authentication is used',
      'Tokens: 12,345 used',
      'https://example.com/a'
    ]) {
      expect(redactText(text)).toBe(text);
    }
  });

  it('never throws on odd input', () => {
    expect(redactText(null)).toBe('');
    expect(redactText(42)).toBe('');
    expect(redactText(undefined)).toBe('');
  });
});
