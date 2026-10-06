import type { AgentProvider } from '@agenterm/core';

const PROVIDER_CODES: Record<AgentProvider, string> = {
  claude: 'CLD',
  codex: 'CDX',
  gemini: 'GEM',
  opencode: 'OPC',
  generic: 'GEN'
};

/**
 * Short spoken handle for a session, like a flight callsign: provider
 * code plus the first four id characters (CLD-7B01). Generic sessions
 * use the command's own name so `bun dev` reads as BUN-….
 */
export function callsign(session: { id: string; provider: AgentProvider; commandLine: string[] }): string {
  let code = PROVIDER_CODES[session.provider];
  if (session.provider === 'generic') {
    const binary = (session.commandLine[0] ?? '').split(/[\\/]/).pop() ?? '';
    const letters = binary.replace(/[^a-z0-9]/gi, '').slice(0, 3).toUpperCase();
    if (letters.length > 0) code = letters;
  }
  return `${code}-${session.id.slice(0, 4).toUpperCase()}`;
}
