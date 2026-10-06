import type { AgentProvider } from './agent.js';

/**
 * Session origin.
 *
 * spawned: daemon owns the PTY from spawn time.
 * attached: adopted an existing OS pid with no PTY takeover. Read-only join.
 */
export type SessionOrigin = 'spawned' | 'attached';

/**
 * PTY and process truth lifecycle.
 *
 * created: row written, spawn requested, PTY not yet confirmed.
 * starting: PTY confirmed, child alive, first output may not have arrived.
 * running: child alive and streaming.
 * exited: child ended with an exit code. Terminal truth, never overridden.
 * crashed: daemon restarted or PTY lost unexpectedly. Log kept.
 * killed: ended by an explicit kill-tree or signal request from the user.
 */
export type SessionLifecycleStatus = 'created' | 'starting' | 'running' | 'exited' | 'crashed' | 'killed';

/**
 * Best-effort overlay status.
 *
 * Comes from harness files or the local OTEL sink. Always redacted before
 * storage. Defaults to unknown. Never overrides PTY and process exit truth.
 * unknown: no overlay data or parse mismatch.
 * working: harness reports active work.
 * waiting_input: harness reports idle wait for typed input.
 * waiting_permission: harness reports a permission prompt needs approval.
 * completed: harness reports task done.
 * failed: harness reports task failure.
 */
export type SessionOverlayStatus =
  'unknown' | 'working' | 'waiting_input' | 'waiting_permission' | 'completed' | 'failed';

/** Source of the overlay value. pty is local truth, others are overlays. */
export type OverlaySource = 'pty' | 'harness' | 'otel';

/**
 * Session row. Central record.
 *
 * Owns agent, provider, human title, cwd, worktree root, branch, origin,
 * exact command line, OS pid, lifecycle status, overlay status with source,
 * terminal dimensions, start and end times, and exit code.
 */
export interface SessionRecord {
  /** Stable session identifier. UUID string. */
  id: string;
  /** Agent definition that owns this session. References AgentRecord.id. */
  agentId: string;
  /** Provider key copied from the agent at spawn or attach time. */
  provider: AgentProvider;
  /** Human title. Never empty. */
  title: string;
  /** Absolute working directory. Must be absolute. */
  cwd: string;
  /** Worktree root or null when unknown or not a repo. */
  worktreeRoot: string | null;
  /** Branch name or null when unknown. */
  branch: string | null;
  /** Origin flag. See SessionOrigin. */
  origin: SessionOrigin;
  /** Exact command line elements. First element is the binary. */
  commandLine: string[];
  /** Resolved absolute binary path or null when not yet resolved. */
  resolvedBinaryPath: string | null;
  /** OS pid of the session leader. Integer, > 0. */
  pid: number;
  /** Lifecycle status. See SessionLifecycleStatus. */
  lifecycle: SessionLifecycleStatus;
  /** Overlay status. See SessionOverlayStatus. Defaults to unknown. */
  overlay: SessionOverlayStatus;
  /** Overlay source. See OverlaySource. Defaults to pty. */
  overlaySource: OverlaySource;
  /** Terminal width in columns. Integer, >= 1. */
  cols: number;
  /** Terminal height in rows. Integer, >= 1. */
  rows: number;
  /** Start time. Milliseconds since epoch. */
  startedAtMs: number;
  /** End time or null while running. Milliseconds since epoch. */
  endedAtMs: number | null;
  /** Exit code or null while running. Integer. */
  exitCode: number | null;
  /** Exit signal name or null. Example: SIGTERM. */
  exitSignal: string | null;
}
