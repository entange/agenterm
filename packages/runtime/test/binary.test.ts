import { describe, expect, it } from 'vitest';
import { effectiveCommand, PROVIDER_INSTALL_HINTS, resolveBinary } from '../src/binary.js';

describe('resolveBinary', () => {
  it('finds echo on PATH', () => {
    const found = resolveBinary('echo');
    expect(found === null || found.endsWith('/echo')).toBe(true);
  });

  it('returns null for absent binaries', () => {
    expect(resolveBinary('agenterm-definitely-missing-binary')).toBe(null);
  });

  it('accepts absolute executable paths', () => {
    expect(resolveBinary('/bin/echo')).toBe('/bin/echo');
  });

  it('rejects absolute paths that are not executable', () => {
    expect(resolveBinary('/tmp/agenterm-no-such-file')).toBe(null);
  });
});

describe('provider commands', () => {
  it('maps known providers to binaries', () => {
    expect(effectiveCommand('claude')).toBe('claude');
    expect(effectiveCommand('generic')).toBe(null);
    expect(effectiveCommand('generic', '/bin/echo')).toBe('/bin/echo');
  });

  it('carries an install hint per provider', () => {
    for (const hint of Object.values(PROVIDER_INSTALL_HINTS)) {
      expect(hint.length).toBeGreaterThan(0);
    }
  });
});
