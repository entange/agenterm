import type { HarnessProvider } from '@agenterm/core';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { geminiAdapter } from './gemini.js';
import { opencodeAdapter } from './opencode.js';
import type { HarnessAdapter } from './types.js';

export type { HarnessAdapter } from './types.js';
export { tailFile, newestFiles, parseTail } from './types.js';
export { claudeAdapter } from './claude.js';
export { codexAdapter } from './codex.js';
export { opencodeAdapter } from './opencode.js';
export { geminiAdapter } from './gemini.js';

const BY_PROVIDER: Record<HarnessProvider, HarnessAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  opencode: opencodeAdapter,
  gemini: geminiAdapter
};

/** Adapter for a provider, or null for generic commands with no harness. */
export function adapterFor(provider: string): HarnessAdapter | null {
  if (provider !== 'claude' && provider !== 'codex' && provider !== 'opencode' && provider !== 'gemini') {
    return null;
  }
  return BY_PROVIDER[provider];
}
