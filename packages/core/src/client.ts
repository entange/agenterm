import type {
  ActivityResponse,
  ClearTasksResponse,
  HealthResponse,
  ListProcessesResponse,
  ListTasksResponse,
  RemoveTaskResponse,
  RunTaskRequest,
  RunTaskResponse,
  Settings,
  StopProcessRequest,
  StopProcessResponse,
  StopTaskRequest,
  TaskInputRequest,
  TaskInputResponse,
  TaskOutputQuery,
  TaskOutputResponse,
  TaskResizeRequest,
  TaskResponse
} from './api.js';

/** Client options. Token is read from the agenterm data dir by the caller. */
export interface ApiClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  /** Give up on a request after this long. A wedged daemon must not hang the CLI or MCP. Default 30s. */
  timeoutMs?: number;
}

/**
 * Error thrown for non-2xx daemon replies. Carries the envelope code and
 * hint so callers can branch on `unknown_task`, `invalid_cwd`, ...
 */
export class AgentermApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint: string | undefined;

  constructor(status: number, code: string, message: string, hint?: string) {
    super(message);
    this.name = 'AgentermApiError';
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AgentermApiError(
      response.status,
      'malformed_response',
      `daemon returned malformed JSON with status ${response.status}`
    );
  }
}

function ensureOk(response: Response, body: unknown): void {
  if (response.ok) return;
  const record = body as Record<string, unknown> | null;
  const nested = record?.['error'] as Record<string, unknown> | undefined;
  const message =
    typeof nested?.['message'] === 'string' ? nested['message'] : `request failed with status ${response.status}`;
  const code = typeof nested?.['code'] === 'string' ? nested['code'] : 'http_error';
  const hint = typeof nested?.['hint'] === 'string' ? nested['hint'] : undefined;
  throw new AgentermApiError(response.status, code, message, hint);
}

function querySuffix(entries: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params.size > 0 ? `?${params.toString()}` : '';
}

/**
 * Typed daemon client shared by the desktop app, the CLI, and the MCP server.
 *
 * Thin wrapper over localhost HTTP. Validation lives in the daemon; this
 * layer only maps envelopes to typed results and errors.
 */
export class AgentermClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.token = options.token;
    // Wrapped so the global fetch is never called with this client as its receiver.
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private async request<T>(
    method: string,
    pathname: string,
    payload?: unknown,
    timeoutMs = this.timeoutMs
  ): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(payload);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${pathname}`, init);
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new AgentermApiError(
          504,
          'timeout',
          `the daemon did not answer ${method} ${pathname} within ${Math.round(timeoutMs / 1000)}s`,
          'It may be overloaded or stuck; `agenterm daemon logs` shows what it is doing.'
        );
      }
      throw error;
    }
    const body = await readJson(response);
    ensureOk(response, body);
    return body as T;
  }

  private taskPath(id: string, suffix = ''): string {
    return `/tasks/${encodeURIComponent(id)}${suffix}`;
  }

  health(): Promise<HealthResponse> {
    return this.request('GET', '/health', undefined, Math.min(this.timeoutMs, 5000));
  }

  listTasks(): Promise<ListTasksResponse> {
    return this.request('GET', '/tasks');
  }

  getTask(id: string): Promise<TaskResponse> {
    return this.request('GET', this.taskPath(id));
  }

  run(request: RunTaskRequest): Promise<RunTaskResponse> {
    return this.request('POST', '/tasks', request);
  }

  /** Resolves once the task has ended (up to about 10 seconds for a graceful stop). */
  stop(id: string, request: StopTaskRequest = {}): Promise<TaskResponse> {
    return this.request('POST', this.taskPath(id, '/stop'), request);
  }

  remove(id: string): Promise<RemoveTaskResponse> {
    return this.request('DELETE', this.taskPath(id));
  }

  clearEnded(): Promise<ClearTasksResponse> {
    return this.request('POST', '/tasks/clear', {});
  }

  sendInput(id: string, request: TaskInputRequest): Promise<TaskInputResponse> {
    return this.request('POST', this.taskPath(id, '/input'), request);
  }

  resize(id: string, request: TaskResizeRequest): Promise<TaskResponse> {
    return this.request('POST', this.taskPath(id, '/resize'), request);
  }

  output(id: string, query: TaskOutputQuery = {}): Promise<TaskOutputResponse> {
    return this.request(
      'GET',
      this.taskPath(
        id,
        `/output${querySuffix({ tailBytes: query.tailBytes, sinceSeq: query.sinceSeq, limit: query.limit })}`
      )
    );
  }

  /** Commands running outside agenterm: in terminals, under agents, or orphaned. */
  listProcesses(): Promise<ListProcessesResponse> {
    return this.request('GET', '/processes');
  }

  /** End a command running outside agenterm and everything under it. */
  stopProcess(pid: number, request: StopProcessRequest = {}): Promise<StopProcessResponse> {
    return this.request('POST', `/processes/${pid}/stop`, request);
  }

  activity(): Promise<ActivityResponse> {
    return this.request('GET', '/activity');
  }

  settings(): Promise<Settings> {
    return this.request('GET', '/settings');
  }

  updateSettings(patch: Partial<Settings>): Promise<Settings> {
    return this.request('PATCH', '/settings', patch);
  }
}

/** Resolve the daemon base URL from an explicit port. Localhost only. */
export function daemonBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}
