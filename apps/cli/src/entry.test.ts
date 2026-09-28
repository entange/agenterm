import { describe, expect, it } from 'vitest';
import { Command } from 'commander';

describe('cli definition', () => {
  it('builds a program with the expected commands', () => {
    const program = new Command();
    program.name('agenterm');
    program.command('status');
    program.command('discover');
    expect(program.commands.map((c) => c.name())).toEqual(['status', 'discover']);
  });
});
