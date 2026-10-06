import { describe, expect, it } from 'vitest';
import { buildSpawnEnv } from '../src/env.js';

describe('buildSpawnEnv', () => {
  it('inherits the login env agents need and applies overrides', () => {
    const env = buildSpawnEnv(
      { HOME: '/Users/me', USER: 'me', SHELL: '/bin/zsh', PATH: '/usr/bin', ANTHROPIC_API_KEY: 'k', LANG: 'C' },
      { FOO: 'bar', PATH: '/opt/bin' }
    );
    expect(env['HOME']).toBe('/Users/me');
    expect(env['USER']).toBe('me');
    expect(env['SHELL']).toBe('/bin/zsh');
    expect(env['ANTHROPIC_API_KEY']).toBe('k');
    expect(env['PATH']).toBe('/opt/bin');
    expect(env['FOO']).toBe('bar');
    expect(env['LANG']).toBe('C');
  });

  it('drops daemon and Electron internals and defaults LANG', () => {
    const env = buildSpawnEnv({ ELECTRON_RUN_AS_NODE: '1', AGENTERM_PORT: '1', HOME: '/h', UNDEF: undefined });
    expect(env).toEqual({ HOME: '/h', LANG: 'en_US.UTF-8' });
  });
});
