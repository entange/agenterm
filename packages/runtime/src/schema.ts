import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * SQLite schema for the local-first store at ~/.agenterm/agenterm.db.
 *
 * Mirrors the verbose row contracts in @agenterm/core. Every table uses a
 * text UUID primary key, millisecond integer timestamps, and indexes on
 * the session and time lookups the UI needs. JSON columns hold stringified
 * maps (env, command lines, payloads) so rows stay queryable without joins.
 */

export const machines = sqliteTable('machines', {
  id: text('id').primaryKey(),
  hostname: text('hostname').notNull(),
  platform: text('platform').notNull(),
  arch: text('arch').notNull(),
  firstSeenAtMs: integer('first_seen_at_ms').notNull(),
  lastSeenAtMs: integer('last_seen_at_ms').notNull()
});

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    machineId: text('machine_id').notNull(),
    name: text('name').notNull(),
    rootPath: text('root_path').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull()
  },
  (table) => [index('projects_machine_idx').on(table.machineId)]
);

export const workspaces = sqliteTable(
  'workspaces',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    cwd: text('cwd').notNull(),
    worktreeRoot: text('worktree_root'),
    branch: text('branch'),
    isDirty: integer('is_dirty'),
    createdAtMs: integer('created_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull()
  },
  (table) => [index('workspaces_project_idx').on(table.projectId), index('workspaces_cwd_idx').on(table.cwd)]
);

export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    provider: text('provider').notNull(),
    displayName: text('display_name').notNull(),
    command: text('command').notNull(),
    argsJson: text('args_json').notNull(),
    envJson: text('env_json').notNull(),
    createdAtMs: integer('created_at_ms').notNull()
  },
  (table) => [index('agents_workspace_idx').on(table.workspaceId)]
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    provider: text('provider').notNull(),
    title: text('title').notNull(),
    cwd: text('cwd').notNull(),
    worktreeRoot: text('worktree_root'),
    branch: text('branch'),
    origin: text('origin').notNull(),
    commandLineJson: text('command_line_json').notNull(),
    resolvedBinaryPath: text('resolved_binary_path'),
    pid: integer('pid').notNull(),
    lifecycle: text('lifecycle').notNull(),
    overlay: text('overlay').notNull(),
    overlaySource: text('overlay_source').notNull(),
    cols: integer('cols').notNull(),
    rows: integer('rows').notNull(),
    startedAtMs: integer('started_at_ms').notNull(),
    endedAtMs: integer('ended_at_ms'),
    exitCode: integer('exit_code'),
    exitSignal: text('exit_signal')
  },
  (table) => [
    index('sessions_started_idx').on(table.startedAtMs),
    index('sessions_lifecycle_idx').on(table.lifecycle),
    index('sessions_cwd_idx').on(table.cwd)
  ]
);

export const processes = sqliteTable(
  'processes',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    pid: integer('pid').notNull(),
    ppid: integer('ppid').notNull(),
    command: text('command').notNull(),
    cwd: text('cwd'),
    cpuPercent: integer('cpu_percent'),
    rssBytes: integer('rss_bytes'),
    startedAtMs: integer('started_at_ms'),
    endedAtMs: integer('ended_at_ms'),
    exitCode: integer('exit_code'),
    sampledAtMs: integer('sampled_at_ms').notNull()
  },
  (table) => [
    index('processes_session_idx').on(table.sessionId),
    index('processes_sampled_idx').on(table.sampledAtMs)
  ]
);

export const commands = sqliteTable(
  'commands',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    text: text('text').notNull(),
    cwd: text('cwd').notNull(),
    pid: integer('pid'),
    startedAtMs: integer('started_at_ms').notNull(),
    durationMs: integer('duration_ms'),
    exitCode: integer('exit_code'),
    outputLineCount: integer('output_line_count')
  },
  (table) => [
    index('commands_session_idx').on(table.sessionId),
    index('commands_started_idx').on(table.startedAtMs)
  ]
);

export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    kind: text('kind').notNull(),
    payloadJson: text('payload_json').notNull(),
    createdAtMs: integer('created_at_ms').notNull()
  },
  (table) => [
    index('events_session_idx').on(table.sessionId),
    index('events_time_idx').on(table.createdAtMs)
  ]
);

/** All tables in dependency order for schema creation. */
export const ALL_TABLES = [machines, projects, workspaces, agents, sessions, processes, commands, events] as const;
