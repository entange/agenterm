import { describe, expect, it } from 'vitest';
import { parseEnvDump } from './loginEnv.js';

describe('parseEnvDump', () => {
  it('reads NUL-separated env between markers and ignores shell noise', () => {
    const dump =
      'motd banner\n__AGENTERM_ENV__PATH=/opt/homebrew/bin:/usr/bin\0HOME=/Users/me\0EMPTY=\0MULTI=a=b\0__AGENTERM_ENV__trailing';
    expect(parseEnvDump(dump)).toEqual({
      PATH: '/opt/homebrew/bin:/usr/bin',
      HOME: '/Users/me',
      EMPTY: '',
      MULTI: 'a=b'
    });
  });

  it('returns null without both markers', () => {
    expect(parseEnvDump('no markers here')).toBe(null);
  });
});
