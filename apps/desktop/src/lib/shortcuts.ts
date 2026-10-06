import { getBridge } from './bridge.js';

const mac =
  (getBridge()?.platform ?? navigator.platform.toLowerCase()).startsWith('darwin') ||
  navigator.platform.startsWith('Mac');

/**
 * Display label for an app shortcut, matching the menu accelerators:
 * Cmd on macOS, Ctrl+Shift elsewhere (plain Ctrl keys belong to terminals).
 */
export function shortcut(key: string, options: { shift?: boolean } = {}): string {
  if (mac) return `${options.shift === true ? '⇧' : ''}⌘${key}`;
  return `Ctrl+Shift+${key}`;
}
