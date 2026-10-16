import fs from 'node:fs';
import type { Settings } from '@agenterm/core';
import { PRIVATE_FILE_MODE } from './database.js';

export const DEFAULT_SETTINGS: Settings = { stopWithAgent: false, hiddenCommands: [] };

/** Read settings.json. Missing or malformed files give the defaults. */
export function loadSettings(file: string | undefined): Settings {
  if (file === undefined) return { ...DEFAULT_SETTINGS, hiddenCommands: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Settings>;
    const hidden = Array.isArray(parsed.hiddenCommands) ? parsed.hiddenCommands : [];
    return {
      stopWithAgent: parsed.stopWithAgent === true,
      hiddenCommands: hidden
        .filter((name): name is string => typeof name === 'string')
        .map((name) => name.toLowerCase())
    };
  } catch {
    return { ...DEFAULT_SETTINGS, hiddenCommands: [] };
  }
}

export function saveSettings(file: string | undefined, settings: Settings): void {
  if (file === undefined) return;
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
}
