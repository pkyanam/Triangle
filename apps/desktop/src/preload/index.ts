import { contextBridge, ipcRenderer } from 'electron';
import type {
  AgentEvent,
  ApprovalRequest,
  FileChangeEvent,
  PreviewRequest,
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
    list: () => ipcRenderer.invoke('project:list'),
    templates: () => ipcRenderer.invoke('template:list'),
    create: (req) => ipcRenderer.invoke('project:create', req),
    open: (id) => ipcRenderer.invoke('project:open', { id }),
    export: (id) => ipcRenderer.invoke('project:export', { id }),
    exportHtml: (id) => ipcRenderer.invoke('project:export-html', { id }),
    import: () => ipcRenderer.invoke('project:import'),
    importDir: () => ipcRenderer.invoke('project:import-dir'),
    onFileChanged: (cb) => subscribe<FileChangeEvent>('project:file-changed', cb),
    onChanged: (cb) => subscribe<ProjectInfo>('project:changed', cb),
    assets: () => ipcRenderer.invoke('project:assets'),
  },
  file: {
    read: (path) => ipcRenderer.invoke('file:read', { path }),
    write: (req) => ipcRenderer.invoke('file:write', req),
  },
  asset: {
    dataUrl: (path) => ipcRenderer.invoke('asset:data-url', { path }),
    import: () => ipcRenderer.invoke('asset:import'),
  },
  agent: {
    harnesses: () => ipcRenderer.invoke('agent:harnesses'),
    start: (req) => ipcRenderer.invoke('agent:start', req),
    cancel: (runId) => ipcRenderer.invoke('agent:cancel', { runId }),
    approve: (decision) => ipcRenderer.invoke('agent:approval', decision),
    onEvent: (cb) => subscribe<AgentEvent>('agent:event', cb),
    onApprovalRequest: (cb) => subscribe<ApprovalRequest>('agent:approval-request', cb),
  },
  devin: {
    sessions: () => ipcRenderer.invoke('devin:sessions'),
    logout: () => ipcRenderer.invoke('devin:logout'),
  },
  session: {
    list: () => ipcRenderer.invoke('session:list'),
    get: (id) => ipcRenderer.invoke('session:get', { id }),
    clear: () => ipcRenderer.invoke('session:clear'),
  },
  snapshot: {
    list: () => ipcRenderer.invoke('snapshot:list'),
    create: (name) => ipcRenderer.invoke('snapshot:create', { name }),
    restore: (id) => ipcRenderer.invoke('snapshot:restore', { id }),
  },
  mcp: {
    endpoint: () => ipcRenderer.invoke('mcp:endpoint'),
  },
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (patch) => ipcRenderer.invoke('config:set', patch),
  },
  preview: {
    onRequest: (cb) => subscribe<PreviewRequest>('preview:request', cb),
    result: (result) => ipcRenderer.invoke('preview:result', result),
    event: (event) => ipcRenderer.invoke('preview:event', event),
    saveCapture: (dataUrl) => ipcRenderer.invoke('preview:save-capture', { dataUrl }),
  },
  tool: {
    run: (req) => ipcRenderer.invoke('tool:run', req),
  },
  hf: {
    deviceCode: (req) => ipcRenderer.invoke('hf:device-code', req),
    pollToken: (req) => ipcRenderer.invoke('hf:poll-token', req),
    disconnect: () => ipcRenderer.invoke('hf:disconnect'),
    status: () => ipcRenderer.invoke('hf:status'),
  },
};

contextBridge.exposeInMainWorld('triangle', api);
