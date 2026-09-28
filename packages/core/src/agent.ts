/**
 * Agent provider key.
 *
 * One of the four known harness binaries plus a generic fallback that can
 * run any user-supplied command with full fidelity.
 */
export type AgentProvider = 'claude' | 'codex' | 'gemini' | 'opencode' | 'generic';

/** All provider keys in sorted order for UI select lists. */
export const AGENT_PROVIDERS: readonly AgentProvider[] = [
  'claude',
  'codex',
  'gemini',
  'generic',
  'opencode'
] as const;

/**
 * Agent definition row.
 *
 * A configured agent definition per workspace. Stores the exact command plus
 * argument list, environment overrides minus the secrets blocklist, and
 * creation time. Generic entries hold any binary.
 */
export interface AgentRecord {
  /** Stable agent identifier. UUID string. */
  id: string;
  /** Workspace that owns this agent. References WorkspaceRecord.id. */
  workspaceId: string;
  /** Provider key. Controls default binary and install hint. */
  provider: AgentProvider;
  /** Display name shown in lists. Never empty. */
  displayName: string;
  /** Exact binary name or absolute path. Never empty. Example: claude. */
  command: string;
  /** Argument list. May be empty. Each entry is one argv element. */
  args: string[];
  /**
   * Environment overrides. Keys and values are plain strings. Must never
   * contain secrets-blocklist keys. Callers must strip those before storage.
   */
  env: Record<string, string>;
  /** Creation time. Milliseconds since epoch. */
  createdAtMs: number;
}

/** Input to create an agent definition. */
export interface CreateAgentInput {
  workspaceId: string;
  provider: AgentProvider;
  displayName: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}
