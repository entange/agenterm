import type { AgentermBridge, ApiArgs, ApiMethod, ApiResult } from '../../shared/bridge.js';

/** Daemon error with its machine code and recovery hint. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint: string | undefined;

  constructor(status: number, code: string, message: string, hint?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

export function getBridge(): AgentermBridge | null {
  return (window as unknown as { agenterm?: AgentermBridge }).agenterm ?? null;
}

export function bridge(): AgentermBridge {
  const found = getBridge();
  if (found === null) throw new ApiError(0, 'no_bridge', 'agenterm must run inside its desktop app.');
  return found;
}

/** Call one daemon method through main and unwrap the result envelope. */
export async function api<M extends ApiMethod>(method: M, ...args: ApiArgs<M>): Promise<ApiResult<M>> {
  const envelope = await bridge().call(method, ...args);
  if (envelope.ok) return envelope.value;
  throw new ApiError(envelope.error.status, envelope.error.code, envelope.error.message, envelope.error.hint);
}
