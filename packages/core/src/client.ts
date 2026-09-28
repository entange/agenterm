import type {
  AttachSessionRequest,
  AttachSessionResponse,
  DeleteSessionRequest,
  DeleteSessionResponse,
  DiscoverResponse,
  HealthResponse,
  ListSessionsQuery,
  ListSessionsResponse,
  SessionDetailResponse,
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
  SpawnSessionResponse
} from './api.js';

/** Client options. Token is read from the agenterm data dir by the caller. */
export interface ApiClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`daemon returned malformed JSON with status ${response.status}`);
  }
}

function ensureOk(response: Response, body: unknown): void {
  if (response.ok) return;
  const record = body as Record<string, unknown> | null;
  const nested = record?.['error'] as Record<string, unknown> | undefined;
  const message =
    typeof nested?.['message'] === 'string' ? nested['message'] : `request failed with status ${response.status}`;
  throw new Error(message);
}

/**
 * Typed daemon client shared by the desktop UI and the CLI.
 *
 * Thin wrapper over localhost HTTP. Validation lives in the daemon; this
 * layer only maps envelopes to typed results.
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

  async health(): Promise<HealthResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/health`, {
      headers: { Authorization: `Bearer ${this.token}` }
    });
    const body = await readJson(response);
    ensureOk(response, body);
    return body as HealthResponse;
  }

  async discover(): Promise<DiscoverResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/discover`, {
      headers: { Authorization: `Bearer ${this.token}` }
    });
    const body = await readJson(response);
    ensureOk(response, body);
    return body as DiscoverResponse;
  }

  async listSessions(query: ListSessionsQuery = {}): Promise<ListSessionsResponse> {
    const params = new URLSearchParams();
    if (query.provider !== undefined) params.set('provider', query.provider);
    if (query.lifecycle !== undefined) params.set('lifecycle', query.lifecycle);
    if (query.overlay !== undefined) params.set('overlay', query.overlay);
    if (query.cwd !== undefined) params.set('cwd', query.cwd);
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    const response = await this.fetchImpl(`${this.baseUrl}/sessions${suffix}`, {
      headers: { Authorization: `Bearer ${this.token}` }
    });
    const body = await readJson(response);
    ensureOk(response, body);
    return body as ListSessionsResponse;
  }

  async attach(request: AttachSessionRequest): Promise<AttachSessionResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/sessions/attach`, {
      method: 'POST',
      headers: authHeaders(this.token),
      body: JSON.stringify(request)
    });
    const body = await readJson(response);
    ensureOk(response, body);
    return body as AttachSessionResponse;
  }

  async sessionDetail(id: string): Promise<SessionDetailResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/sessions/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${this.token}` }
    });
    const body = await readJson(response);
    ensureOk(response, body);
    return body as SessionDetailResponse;
  }

  async spawn(request: SpawnSessionRequest): Promise<SpawnSessionResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/sessions`, {
      method: 'POST',
      headers: authHeaders(this.token),
      body: JSON.stringify(request)
    });
    const body = await readJson(response);
    ensureOk(response, body);
    return body as SpawnSessionResponse;
  }

  async deleteSession(id: string, request: DeleteSessionRequest): Promise<DeleteSessionResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: authHeaders(this.token),
      body: JSON.stringify(request)
    });
    const body = await readJson(response);
    ensureOk(response, body);
    return body as DeleteSessionResponse;
  }

  async sendInput(id: string, request: SessionInputRequest): Promise<SessionInputResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/sessions/${encodeURIComponent(id)}/input`, {
      method: 'POST',
      headers: authHeaders(this.token),
      body: JSON.stringify(request)
    });
    const body = await readJson(response);
    ensureOk(response, body);
    return body as SessionInputResponse;
  }

  async resize(id: string, request: SessionResizeRequest): Promise<SessionResizeResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/sessions/${encodeURIComponent(id)}/resize`, {
      method: 'POST',
      headers: authHeaders(this.token),
      body: JSON.stringify(request)
    });
    const body = await readJson(response);
    ensureOk(response, body);
    return body as SessionResizeResponse;
  }

  async signal(id: string, request: SessionSignalRequest): Promise<SessionSignalResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/sessions/${encodeURIComponent(id)}/signal`, {
      method: 'POST',
      headers: authHeaders(this.token),
      body: JSON.stringify(request)
    });
    const body = await readJson(response);
    ensureOk(response, body);
    return body as SessionSignalResponse;
  }

  async output(id: string, query: SessionOutputQuery = {}): Promise<SessionOutputResponse> {
    const params = new URLSearchParams();
    if (query.tailBytes !== undefined) params.set('tailBytes', String(query.tailBytes));
    if (query.sinceSeq !== undefined) params.set('sinceSeq', String(query.sinceSeq));
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    const response = await this.fetchImpl(`${this.baseUrl}/sessions/${encodeURIComponent(id)}/output${suffix}`, {
      headers: { Authorization: `Bearer ${this.token}` }
    });
    const body = await readJson(response);
    ensureOk(response, body);
    return body as SessionOutputResponse;
  }

  async processes(id: string): Promise<SessionProcessesResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/sessions/${encodeURIComponent(id)}/processes`, {
      headers: { Authorization: `Bearer ${this.token}` }
    });
    const body = await readJson(response);
    ensureOk(response, body);
    return body as SessionProcessesResponse;
  }

  async ports(id: string): Promise<SessionPortsResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/sessions/${encodeURIComponent(id)}/ports`, {
      headers: { Authorization: `Bearer ${this.token}` }
    });
    const body = await readJson(response);
    ensureOk(response, body);
    return body as SessionPortsResponse;
  }
}

/** Resolve the daemon base URL from an explicit port. Localhost only. */
export function daemonBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}
