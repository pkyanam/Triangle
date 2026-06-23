import { contextBridge, ipcRenderer } from 'electron';
import type {
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
};

contextBridge.exposeInMainWorld('triangle', api);
