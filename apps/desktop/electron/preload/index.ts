import { contextBridge, ipcRenderer } from 'electron';

/**
 * Preload bridge.
 *
 * Exposes daemon calls without forwarding the raw token to web content.
 * Renderer code calls window.agenterm.health() and similar helpers.
 */
export interface AgentermBridge {
  health: () => Promise<unknown>;
  discover: () => Promise<unknown>;
  listSessions: () => Promise<unknown>;
}

const bridge: AgentermBridge = {
  health: () => ipcRenderer.invoke('agenterm:health'),
  discover: () => ipcRenderer.invoke('agenterm:discover'),
  listSessions: () => ipcRenderer.invoke('agenterm:list')
};

contextBridge.exposeInMainWorld('agenterm', bridge);
