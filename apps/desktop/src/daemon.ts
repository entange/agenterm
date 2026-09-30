import type {
  AgentermEvent,
  DiscoverResponse,
  ListSessionsResponse,
  SessionDetailResponse,
  SessionOutputResponse
} from '@agenterm/core';

/** Renderer-side view of the preload bridge. Token never reaches this layer. */
export interface RendererBridge {
  health: () => Promise<unknown>;
  discover: () => Promise<DiscoverResponse>;
  listSessions: () => Promise<ListSessionsResponse>;
  spawn: (body: Record<string, unknown>) => Promise<{ session: { id: string } }>;
  attach: (body: Record<string, unknown>) => Promise<{ session: { id: string } }>;
  detail: (id: string) => Promise<SessionDetailResponse>;
  output: (id: string, sinceSeq?: number) => Promise<SessionOutputResponse>;
  input: (id: string, data: string) => Promise<unknown>;
  resize: (id: string, cols: number, rows: number) => Promise<unknown>;
  signal: (id: string, signal: string) => Promise<unknown>;
  endSession: (id: string, killTree: boolean) => Promise<unknown>;
  onEvent: (handler: (event: AgentermEvent) => void) => () => void;
}

export function getBridge(): RendererBridge | null {
  const scoped = window as unknown as { agenterm?: RendererBridge };
  return scoped.agenterm ?? null;
}
