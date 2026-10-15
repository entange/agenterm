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
  type CliStatus,
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

// Menu, tray, and notification commands can arrive before React subscribes
// (a fresh window right after load); hold them until a handler exists.
const commandHandlers = new Set<(command: AppCommand) => void>();
const pendingCommands: AppCommand[] = [];
ipcRenderer.on(IPC.command, (_event: IpcRendererEvent, command: AppCommand) => {
  if (commandHandlers.size === 0) pendingCommands.push(command);
  else for (const handler of commandHandlers) handler(command);
});

const bridge: AgentermBridge = {
  platform: process.platform,
  call: <M extends ApiMethod>(method: M, ...args: ApiArgs<M>) =>
    ipcRenderer.invoke(IPC.call, method, args) as Promise<ApiEnvelope<ApiResult<M>>>,
  sendInput: (taskId, data) => ipcRenderer.send(IPC.input, taskId, data),
  subscribeOutput: (taskId) => ipcRenderer.send(IPC.subscribe, taskId),
  unsubscribeOutput: (taskId) => ipcRenderer.send(IPC.unsubscribe, taskId),
  onEvent: (handler) => listen<AgentermEvent>(IPC.event, handler),
  onActivity: (handler) => listen<ActivityTick>(IPC.activity, handler),
  onConnection: (handler) => listen<ConnectionInfo>(IPC.connection, handler),
  onCommand: (handler) => {
    commandHandlers.add(handler);
    for (const command of pendingCommands.splice(0)) handler(command);
    return () => {
      commandHandlers.delete(handler);
    };
  },
  connection: () => ipcRenderer.invoke(IPC.getConnection) as Promise<ConnectionInfo>,
  startDaemon: () => ipcRenderer.invoke(IPC.startDaemon) as Promise<ConnectionInfo>,
  stopDaemon: () => ipcRenderer.invoke(IPC.stopDaemon) as Promise<boolean>,
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url) as Promise<void>,
  revealPath: (target) => ipcRenderer.invoke(IPC.revealPath, target) as Promise<void>,
  preferences: () => ipcRenderer.invoke(IPC.preferences) as Promise<Preferences>,
  setPreferences: (patch) => ipcRenderer.invoke(IPC.setPreferences, patch) as Promise<Preferences>,
  cliStatus: () => ipcRenderer.invoke(IPC.cliStatus) as Promise<CliStatus>,
  installCli: () => ipcRenderer.invoke(IPC.installCli) as Promise<CliStatus>
};

contextBridge.exposeInMainWorld('agenterm', bridge);
