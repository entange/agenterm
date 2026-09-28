/**
 * Machine row.
 *
 * One row per host that has run the daemon. Stored in SQLite via drizzle-orm
 * in a later change. For now this type fixes the contract used by the API
 * and by retention tooling.
 */
export interface MachineRecord {
  /** Stable machine identifier. UUID string. Never empty. */
  id: string;
  /** OS hostname at first sight. Human readable. Never empty. */
  hostname: string;
  /** Platform token from the OS layer. Example: darwin, win32, linux. */
  platform: string;
  /** CPU architecture token. Example: arm64, x64. */
  arch: string;
  /** First sight timestamp. Milliseconds since epoch. Integer, >= 0. */
  firstSeenAtMs: number;
  /** Most recent heartbeat timestamp. Milliseconds since epoch. Integer, >= 0. */
  lastSeenAtMs: number;
}

/** Input required to register a machine. All fields mandatory. */
export interface RegisterMachineInput {
  hostname: string;
  platform: string;
  arch: string;
}
