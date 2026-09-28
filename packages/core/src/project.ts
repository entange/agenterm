/**
 * Project row.
 *
 * A named grouping with a root path on one machine. Roots are registered
 * explicitly by the user. Renames keep the same row id and update the name
 * plus the updated timestamp. Inference from session cwd is not used: the
 * UI must call the explicit register path.
 */
export interface ProjectRecord {
  /** Stable project identifier. UUID string. */
  id: string;
  /** Machine that owns this project. References MachineRecord.id. */
  machineId: string;
  /** Human title. Never empty. Leading and trailing space trimmed. */
  name: string;
  /** Absolute root path on that machine. Must be absolute. */
  rootPath: string;
  /** Creation time. Milliseconds since epoch. Integer, >= 0. */
  createdAtMs: number;
  /** Last rename or root move time. Milliseconds since epoch. Integer, >= 0. */
  updatedAtMs: number;
}

/** Input to create a project. */
export interface CreateProjectInput {
  machineId: string;
  name: string;
  rootPath: string;
}
