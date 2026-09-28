/**
 * Command row.
 *
 * Higher-level command records derived in a later change. The early scope
 * ships raw terminal only with no derived parsing. This type fixes the
 * contract so storage and UI can grow without breaking callers.
 */
export interface CommandRecord {
  /** Stable command identifier. UUID string. */
  id: string;
  /** Session that ran the command. References SessionRecord.id. */
  sessionId: string;
  /** Command text as typed. Never empty. */
  text: string;
  /** Working directory where the command ran. Absolute path. */
  cwd: string;
  /** OS pid that ran the command or null when unknown. */
  pid: number | null;
  /** Start time. Milliseconds since epoch. */
  startedAtMs: number;
  /** Duration in milliseconds or null while running. Integer, >= 0. */
  durationMs: number | null;
  /** Exit code or null while running or when unknown. */
  exitCode: number | null;
  /** Output line count or null when not counted. Integer, >= 0. */
  outputLineCount: number | null;
}
