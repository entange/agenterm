export type {
  ActivityResponse,
  AgentermEvent,
  ClearTasksResponse,
  ClientSocketMessage,
  ErrorEnvelope,
  HealthResponse,
  ListTasksResponse,
  RemoveTaskResponse,
  RunTaskRequest,
  RunTaskResponse,
  ServerSocketMessage,
  Settings,
  StopTaskRequest,
  TaskActivity,
  TaskInputRequest,
  TaskInputResponse,
  TaskOutputChunk,
  TaskOutputQuery,
  TaskOutputResponse,
  TaskResizeRequest,
  TaskResponse
} from './api.js';
export { AgentermApiError, AgentermClient, daemonBaseUrl } from './client.js';
export { isSecretEnvKey, redactEnvForLog, redactText, stripSecretEnv } from './redaction.js';
export type { TaskRecord, TaskStatus } from './task.js';
export { findTask, isRunning, statusText, TASK_ID_PATTERN } from './task.js';
export { lastVisibleLine, plainText } from './terminalText.js';
export { API_VERSION, VERSION } from './version.js';
export type { ValidationResult } from './validation.js';
export {
  parseRunTaskRequest,
  parseSettingsPatch,
  parseStopTaskRequest,
  parseTaskId,
  parseTaskInputRequest,
  parseTaskOutputQuery,
  parseTaskResizeRequest
} from './validation.js';
