/**
 * Workspace row.
 *
 * A concrete checkout or working directory inside a project. Carries the
 * absolute cwd, the detected worktree root, branch, and dirty-state summary.
 */
export interface WorkspaceRecord {
  /** Stable workspace identifier. UUID string. */
  id: string;
  /** Project that contains this workspace. References ProjectRecord.id. */
  projectId: string;
  /** Absolute working directory. Must be absolute. Never empty. */
  cwd: string;
  /**
   * Detected worktree root. Absolute path or null when the cwd is not inside
   * a git checkout or when git lookup has not run yet.
   */
  worktreeRoot: string | null;
  /**
   * Branch name from rev-parse or null when detached, missing, or not a repo.
   * Never includes remote prefix manipulation: raw branch string only.
   */
  branch: string | null;
  /**
   * Dirty-state summary. True when staged or unstaged changes exist, false
   * when clean, null when git state is unknown.
   */
  isDirty: boolean | null;
  /** Creation time. Milliseconds since epoch. */
  createdAtMs: number;
  /** Last refresh time. Milliseconds since epoch. */
  updatedAtMs: number;
}
