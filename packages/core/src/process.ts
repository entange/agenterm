/**
 * Process snapshot row.
 *
 * Polled view of one OS process inside a session subtree. Sampled on an
 * interval and scoped to session trees. Retention keeps one day of fine
 * samples in the full design; the early store keeps spawn metadata only.
 */
export interface ProcessSnapshot {
  /** OS pid. Integer, > 0. */
  pid: number;
  /** Parent OS pid. Integer, >= 0. Zero means no parent visible. */
  ppid: number;
  /** Session that owns this sample. References SessionRecord.id. */
  sessionId: string;
  /** Full command text. Never empty. */
  command: string;
  /** Working directory where knowable, else null. */
  cwd: string | null;
  /** CPU percent 0-100 or null when sampler has not measured yet. */
  cpuPercent: number | null;
  /** Resident memory in bytes or null when unknown. Integer, >= 0. */
  rssBytes: number | null;
  /** Process start time or null when unknown. Milliseconds since epoch. */
  startedAtMs: number | null;
  /** Process end time or null while alive. Milliseconds since epoch. */
  endedAtMs: number | null;
  /** Exit code or null while alive. Integer. */
  exitCode: number | null;
  /** Sample time. Milliseconds since epoch. */
  sampledAtMs: number;
}

/**
 * Candidate agent process found by discovery.
 *
 * Candidates only. Attachment is a separate approved action.
 */
export interface DiscoveredProcess {
  /** OS pid. Integer, > 0. */
  pid: number;
  /** Parent OS pid. Integer, >= 0. */
  ppid: number;
  /** Full command line text. Never empty. */
  commandLine: string;
  /** Binary name lowercased for matching. Example: claude. */
  binaryName: string;
  /** Working directory where resolvable, else null. */
  cwd: string | null;
}

/**
 * Listening socket joined back to an owning pid.
 *
 * Used by the Ports view to show port to pid to session plus an action
 * that opens http://localhost:port in the browser.
 */
export interface PortRecord {
  /** TCP port number. Integer, 1-65535. */
  port: number;
  /** Owning OS pid. Integer, > 0. */
  pid: number;
  /** Session id that owns the pid or null when outside all sessions. */
  sessionId: string | null;
  /** Local address text. Example: 127.0.0.1. */
  address: string;
}
