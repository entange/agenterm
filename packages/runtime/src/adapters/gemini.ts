import { parseGeminiHarnessPayload } from '@agenterm/core';
import type { HarnessAdapter } from './types.js';

/**
 * Gemini adapter (read-only, flagged).
 *
 * Harness log location is unpinned, so this adapter discovers nothing
 * and always yields unknown until a real path and schema are confirmed
 * with the user. Never guesses and never writes.
 */
export const geminiAdapter: HarnessAdapter = {
  provider: 'gemini',
  discoverFiles: () => [],
  parseText: (text) => parseGeminiHarnessPayload(text)
};
