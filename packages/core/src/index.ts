export type { AgentProvider, AgentRecord, CreateAgentInput } from './agent.js';
export { AGENT_PROVIDERS } from './agent.js';
export type {
  AttachSessionRequest,
  AttachSessionResponse,
  ClientSocketMessage,
  DeleteSessionRequest,
  DeleteSessionResponse,
  DiscoverCandidate,
  DiscoverResponse,
  ErrorEnvelope,
  ActivityResponse,
  SessionActivity,
  SessionUsage,
  UsageResponse,
  OutputMatch,
  OutputSearchResponse,
  EventsQuery,
  EventsResponse,
  FileChangeRecord,
  FileChangesResponse,
  GitDiffResponse,
  GitFileState,
  GitStatusResponse,
  HealthResponse,
  ListSessionsQuery,
  ListSessionsResponse,
  ServerSocketMessage,
  SessionCommandsQuery,
  SessionCommandsResponse,
  SessionDetailResponse,
  SessionInputRequest,
  SessionInputResponse,
  SessionOutputChunk,
  SessionOutputQuery,
  SessionOutputResponse,
  SessionPortsResponse,
  SessionProcessesResponse,
  SessionResizeRequest,
  SessionResizeResponse,
  SessionSignalName,
  SessionSignalRequest,
  SessionSignalResponse,
  SpawnSessionRequest,
  SpawnSessionResponse,
  UpdateSessionRequest,
  UpdateSessionResponse
} from './api.js';
export { AgentermApiError, AgentermClient, daemonBaseUrl } from './client.js';
export type { CommandRecord } from './command.js';
export type { AgentermEvent, EventBase, EventRow } from './event.js';
export { isLiveOnlyEventKind, isTerminalEventKind } from './event.js';
export type { HarnessParseOutcome, HarnessProvider } from './harness.js';
export {
  HARNESS_SUPPORTED_VERSIONS,
  parseClaudeHarnessPayload,
  parseCodexHarnessPayload,
  parseGeminiHarnessPayload,
  parseHarnessPayload,
  parseOpencodeHarnessPayload
} from './harness.js';
export type { MachineRecord, RegisterMachineInput } from './machine.js';
export type { DiscoveredProcess, PortRecord, ProcessSnapshot } from './process.js';
export type { CreateProjectInput, ProjectRecord } from './project.js';
export { isSecretEnvKey, redactEnvForLog, redactText, stripSecretEnv } from './redaction.js';
export type {
  OverlaySource,
  SessionLifecycleStatus,
  SessionOrigin,
  SessionOverlayStatus,
  SessionRecord
} from './session.js';
export type { ValidationResult } from './validation.js';
export {
  parseAgentProvider,
  parseAttachSessionRequest,
  parseDeleteSessionRequest,
  parseEventsQuery,
  parseListSessionsQuery,
  parseNonEmptyString,
  parsePidValue,
  parsePortValue,
  parseSessionIdParam,
  parseSessionInputRequest,
  parseSessionOutputQuery,
  parseSessionResizeRequest,
  parseSessionSignalRequest,
  parseSpawnSessionRequest,
  parseUpdateSessionRequest
} from './validation.js';
export type { WorkspaceRecord } from './workspace.js';
export { lastVisibleLine } from './terminalText.js';
