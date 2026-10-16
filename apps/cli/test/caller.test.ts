import { describe, expect, it } from 'vitest';
import { processName, scriptName } from '@agenterm/core';
import { detectCaller, type ProcInfo } from '../src/caller.js';

function tree(entries: Record<number, ProcInfo>) {
  return (pid: number) => entries[pid] ?? null;
}

describe('detectCaller', () => {
  it('skips shells and launchers to find the agent', () => {
    const read = tree({
      100: { ppid: 90, comm: '/bin/bash', args: 'bash -c agenterm run x' },
      90: { ppid: 80, comm: '/usr/local/bin/npx', args: 'npx agenterm' },
      80: { ppid: 1, comm: 'claude', args: 'claude --model opus' }
    });
    expect(detectCaller(100, read)).toEqual({ name: 'claude', pid: 80 });
  });

  it('sees through npx, which retitles itself "npm exec …"', () => {
    const read = tree({
      100: { ppid: 90, comm: 'npm exec agenterm run --id t echo hi', args: 'npm exec agenterm run --id t echo hi' },
      90: { ppid: 80, comm: '-zsh', args: '-zsh' },
      80: { ppid: 1, comm: '/Applications/Ghostty.app/Contents/MacOS/ghostty', args: 'ghostty' }
    });
    expect(detectCaller(100, read)).toEqual({ name: 'Ghostty', pid: 80 });
  });

  it('names node programs by their script or package', () => {
    const read = tree({
      10: { ppid: 9, comm: '-zsh', args: '-zsh' },
      9: { ppid: 1, comm: 'node', args: 'node --no-warnings /opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js' }
    });
    expect(detectCaller(10, read)).toEqual({ name: 'codex', pid: 9 });
    expect(scriptName('/x/node_modules/@scope/gemini-cli/dist/index.js')).toBe('gemini-cli');
    expect(scriptName('/x/tools/index.js')).toBe(null);
  });

  it('names macOS apps by their outer bundle', () => {
    expect(
      processName({
        comm: '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)',
        args: ''
      })
    ).toBe('Visual Studio Code');
    expect(processName({ comm: '/Applications/iTerm.app/Contents/MacOS/iTerm2', args: '' })).toBe('iTerm');
  });

  it('gives up at system roots and unreadable processes', () => {
    const read = tree({
      10: { ppid: 2, comm: 'zsh', args: 'zsh' },
      2: { ppid: 0, comm: '/sbin/launchd', args: 'launchd' }
    });
    expect(detectCaller(10, read)).toBe(null);
    expect(detectCaller(55, tree({}))).toBe(null);
  });
});
