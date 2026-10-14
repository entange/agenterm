import fs from 'node:fs';
import type { Settings } from '@agenterm/core';
import { PRIVATE_FILE_MODE } from './database.js';

export const DEFAULT_SETTINGS: Settings = { stopWithAgent: false };

/** Read settings.json. Missing or malformed files give the defaults. */
export function loadSettings(file: string | undefined): Settings {
  if (file === undefined) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Settings>;
    return { stopWithAgent: parsed.stopWithAgent === true };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(file: string | undefined, settings: Settings): void {
  if (file === undefined) return;
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
}
