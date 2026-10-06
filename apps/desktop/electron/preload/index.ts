import type { AgentermEvent } from '@agenterm/core';
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC,
  type ActivityTick,
  type AgentermBridge,
  type ApiArgs,
  type ApiEnvelope,
  type ApiMethod,
  type ApiResult,
  type AppCommand,
  type ConnectionInfo,
  type Preferences
} from '../../shared/bridge.js';

/**
 * Preload bridge.
 *
 * Exposes a narrow, typed surface on window.agenterm. The token, the
 * HTTP client, and the daemon socket all live in main; this layer only
 * forwards allowlisted calls and fans events back to the page.
 */
function listen<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const bridge: AgentermBridge = {
  platform: process.platform,
  call: <M extends ApiMethod>(method: M, ...args: ApiArgs<M>) =>
    ipcRenderer.invoke(IPC.call, method, args) as Promise<ApiEnvelope<ApiResult<M>>>,
  sendInput: (sessionId, data) => ipcRenderer.send(IPC.input, sessionId, data),
  subscribeOutput: (sessionId) => ipcRenderer.send(IPC.subscribe, sessionId),
  unsubscribeOutput: (sessionId) => ipcRenderer.send(IPC.unsubscribe, sessionId),
  onEvent: (handler) => listen<AgentermEvent>(IPC.event, handler),
  onActivity: (handler) => listen<ActivityTick>(IPC.activity, handler),
  onConnection: (handler) => listen<ConnectionInfo>(IPC.connection, handler),
  onCommand: (handler) => listen<AppCommand>(IPC.command, handler),
  connection: () => ipcRenderer.invoke(IPC.getConnection) as Promise<ConnectionInfo>,
  startDaemon: () => ipcRenderer.invoke(IPC.startDaemon) as Promise<ConnectionInfo>,
  stopDaemon: () => ipcRenderer.invoke(IPC.stopDaemon) as Promise<boolean>,
  pickDirectory: (defaultPath) => ipcRenderer.invoke(IPC.pickDirectory, defaultPath) as Promise<string | null>,
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url) as Promise<void>,
  revealPath: (target) => ipcRenderer.invoke(IPC.revealPath, target) as Promise<void>,
  preferences: () => ipcRenderer.invoke(IPC.preferences) as Promise<Preferences>,
  setPreferences: (patch) => ipcRenderer.invoke(IPC.setPreferences, patch) as Promise<Preferences>
};

contextBridge.exposeInMainWorld('agenterm', bridge);
