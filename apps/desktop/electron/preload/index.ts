import { contextBridge, ipcRenderer } from 'electron';

/**
 * Preload bridge.
 *
 * Exposes daemon calls without forwarding the raw token to web content.
 * Renderer code calls window.agenterm.health() and similar helpers, and
 * subscribes to live events with onEvent. The main process owns the
 * token, the HTTP calls, and the single event stream.
 */
export interface AgentermBridge {
  health: () => Promise<unknown>;
  discover: () => Promise<unknown>;
  listSessions: () => Promise<unknown>;
  spawn: (body: unknown) => Promise<unknown>;
  attach: (body: unknown) => Promise<unknown>;
  detail: (id: string) => Promise<unknown>;
  output: (id: string, sinceSeq?: number) => Promise<unknown>;
  commands: (id: string) => Promise<unknown>;
  input: (id: string, data: string) => Promise<unknown>;
  resize: (id: string, cols: number, rows: number) => Promise<unknown>;
  signal: (id: string, signal: string) => Promise<unknown>;
  endSession: (id: string, killTree: boolean) => Promise<unknown>;
  onEvent: (handler: (event: unknown) => void) => () => void;
}

const bridge: AgentermBridge = {
  health: () => ipcRenderer.invoke('agenterm:health'),
  discover: () => ipcRenderer.invoke('agenterm:discover'),
  listSessions: () => ipcRenderer.invoke('agenterm:list'),
  spawn: (body: unknown) => ipcRenderer.invoke('agenterm:spawn', body),
  attach: (body: unknown) => ipcRenderer.invoke('agenterm:attach', body),
  detail: (id: string) => ipcRenderer.invoke('agenterm:detail', id),
  output: (id: string, sinceSeq?: number) => ipcRenderer.invoke('agenterm:output', id, sinceSeq),
  commands: (id: string) => ipcRenderer.invoke('agenterm:commands', id),
  input: (id: string, data: string) => ipcRenderer.invoke('agenterm:input', id, data),
  resize: (id: string, cols: number, rows: number) => ipcRenderer.invoke('agenterm:resize', id, cols, rows),
  signal: (id: string, signal: string) => ipcRenderer.invoke('agenterm:signal', id, signal),
  endSession: (id: string, killTree: boolean) => ipcRenderer.invoke('agenterm:kill', id, killTree),
  onEvent: (handler: (event: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown): void => handler(payload);
    ipcRenderer.on('agenterm:event', listener);
    return () => {
      ipcRenderer.removeListener('agenterm:event', listener);
    };
  }
};

contextBridge.exposeInMainWorld('agenterm', bridge);
