import type {
  ActivityResponse,
  AttachSessionRequest,
  AttachSessionResponse,
  DeleteSessionRequest,
  DeleteSessionResponse,
  DiscoverResponse,
  EventsQuery,
  EventsResponse,
  FileChangesResponse,
  GitDiffResponse,
  GitStatusResponse,
  HealthResponse,
  ListSessionsQuery,
  ListSessionsResponse,
  SessionDetailResponse,
  SessionCommandsQuery,
  SessionCommandsResponse,
  SessionInputRequest,
  SessionInputResponse,
  SessionOutputQuery,
  SessionOutputResponse,
  SessionPortsResponse,
  SessionProcessesResponse,
  SessionResizeRequest,
  SessionResizeResponse,
  SessionSignalRequest,
  SessionSignalResponse,
  SpawnSessionRequest,
  SpawnSessionResponse,
  UpdateSessionRequest,
  UpdateSessionResponse
} from './api.js';

/** Client options. Token is read from the agenterm data dir by the caller. */
export interface ApiClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

/**
 * Error thrown for non-2xx daemon replies. Carries the envelope code and
 * hint so callers can branch on `missing_binary`, `session_running`, ...
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
 * Typed daemon client shared by the desktop UI and the CLI.
 *
 * Thin wrapper over localhost HTTP. Validation lives in the daemon; this
 * layer only maps envelopes to typed results and errors.
 */
export class AgentermClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request<T>(method: string, pathname: string, payload?: unknown): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    const init: RequestInit = { method, headers };
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(payload);
    }
    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, init);
    const body = await readJson(response);
    ensureOk(response, body);
    return body as T;
  }

  private sessionPath(id: string, suffix = ''): string {
    return `/sessions/${encodeURIComponent(id)}${suffix}`;
  }

  health(): Promise<HealthResponse> {
    return this.request('GET', '/health');
  }

  discover(): Promise<DiscoverResponse> {
    return this.request('GET', '/discover');
  }

  listSessions(query: ListSessionsQuery = {}): Promise<ListSessionsResponse> {
    return this.request(
      'GET',
      `/sessions${querySuffix({
        provider: query.provider,
        lifecycle: query.lifecycle,
        overlay: query.overlay,
        cwd: query.cwd
      })}`
    );
  }

  attach(request: AttachSessionRequest): Promise<AttachSessionResponse> {
    return this.request('POST', '/sessions/attach', request);
  }

  sessionDetail(id: string): Promise<SessionDetailResponse> {
    return this.request('GET', this.sessionPath(id));
  }

  spawn(request: SpawnSessionRequest): Promise<SpawnSessionResponse> {
    return this.request('POST', '/sessions', request);
  }

  deleteSession(id: string, request: DeleteSessionRequest): Promise<DeleteSessionResponse> {
    return this.request('DELETE', this.sessionPath(id), request);
  }

  updateSession(id: string, request: UpdateSessionRequest): Promise<UpdateSessionResponse> {
    return this.request('PATCH', this.sessionPath(id), request);
  }

  restart(id: string): Promise<UpdateSessionResponse> {
    return this.request('POST', this.sessionPath(id, '/restart'), {});
  }

  sendInput(id: string, request: SessionInputRequest): Promise<SessionInputResponse> {
    return this.request('POST', this.sessionPath(id, '/input'), request);
  }

  resize(id: string, request: SessionResizeRequest): Promise<SessionResizeResponse> {
    return this.request('POST', this.sessionPath(id, '/resize'), request);
  }

  signal(id: string, request: SessionSignalRequest): Promise<SessionSignalResponse> {
    return this.request('POST', this.sessionPath(id, '/signal'), request);
  }

  output(id: string, query: SessionOutputQuery = {}): Promise<SessionOutputResponse> {
    return this.request(
      'GET',
      this.sessionPath(
        id,
        `/output${querySuffix({ tailBytes: query.tailBytes, sinceSeq: query.sinceSeq, limit: query.limit })}`
      )
    );
  }

  processes(id: string): Promise<SessionProcessesResponse> {
    return this.request('GET', this.sessionPath(id, '/processes'));
  }

  ports(id: string): Promise<SessionPortsResponse> {
    return this.request('GET', this.sessionPath(id, '/ports'));
  }

  commands(id: string, query: SessionCommandsQuery = {}): Promise<SessionCommandsResponse> {
    return this.request('GET', this.sessionPath(id, `/commands${querySuffix({ limit: query.limit })}`));
  }

  git(id: string): Promise<GitStatusResponse> {
    return this.request('GET', this.sessionPath(id, '/git'));
  }

  gitDiff(id: string, path: string): Promise<GitDiffResponse> {
    return this.request('GET', this.sessionPath(id, `/git/diff${querySuffix({ path })}`));
  }

  files(id: string): Promise<FileChangesResponse> {
    return this.request('GET', this.sessionPath(id, '/files'));
  }

  activity(): Promise<ActivityResponse> {
    return this.request('GET', '/activity');
  }

  events(query: EventsQuery = {}): Promise<EventsResponse> {
    return this.request(
      'GET',
      `/events${querySuffix({ sessionId: query.sessionId, beforeMs: query.beforeMs, limit: query.limit })}`
    );
  }
}

/** Resolve the daemon base URL from an explicit port. Localhost only. */
export function daemonBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}
