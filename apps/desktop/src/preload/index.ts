import { contextBridge, ipcRenderer } from 'electron';
import type {
  AgentEvent,
  ApprovalRequest,
  FileChangeEvent,
  ProjectInfo,
  TriangleApi,
  Unsubscribe,
} from '@triangle/shared';

/** Subscribe to a main->renderer event channel, returning an unsubscribe fn. */
function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_event: unknown, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: TriangleApi = {
  app: {
    info: () => ipcRenderer.invoke('app:info'),
  },
  project: {
    get: () => ipcRenderer.invoke('project:get'),
    refresh: () => ipcRenderer.invoke('project:refresh'),
    onFileChanged: (cb) => subscribe<FileChangeEvent>('project:file-changed', cb),
    onChanged: (cb) => subscribe<ProjectInfo>('project:changed', cb),
  },
  file: {
    read: (path) => ipcRenderer.invoke('file:read', { path }),
    write: (req) => ipcRenderer.invoke('file:write', req),
  },
  agent: {
    harnesses: () => ipcRenderer.invoke('agent:harnesses'),
    start: (req) => ipcRenderer.invoke('agent:start', req),
    cancel: (runId) => ipcRenderer.invoke('agent:cancel', { runId }),
    approve: (decision) => ipcRenderer.invoke('agent:approval', decision),
    onEvent: (cb) => subscribe<AgentEvent>('agent:event', cb),
    onApprovalRequest: (cb) => subscribe<ApprovalRequest>('agent:approval-request', cb),
  },
};

contextBridge.exposeInMainWorld('triangle', api);
