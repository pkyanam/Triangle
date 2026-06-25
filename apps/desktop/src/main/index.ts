import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import type {
  IpcEventChannel,
  IpcEventPayload,
  IpcInvokeChannel,
  IpcRequest,
  IpcResponse,
} from '@triangle/shared';
import { loadAgentSettings, saveAgentSettings } from './config.js';
import { ProjectManager } from './project.js';
import { AgentManager } from './agent/manager.js';
import { PreviewBridge } from './preview-bridge.js';
import { ToolBridgeServer } from './tool-bridge.js';
import { McpEndpoint } from './mcp-endpoint.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !!process.env['ELECTRON_RENDERER_URL'];

let mainWindow: BrowserWindow | null = null;
let project: ProjectManager;
let agents: AgentManager;
let preview: PreviewBridge;
let toolBridge: ToolBridgeServer;
let mcpEndpoint: McpEndpoint;

/** Decode a `data:…;base64,…` URL into raw bytes. */
function dataUrlToBuffer(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(',');
  return Buffer.from(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl, 'base64');
}

/** Type-safe wrapper around ipcMain.handle keyed by the shared IPC contract. */
function handle<C extends IpcInvokeChannel>(
  channel: C,
  handler: (req: IpcRequest<C>) => Promise<IpcResponse<C>> | IpcResponse<C>,
): void {
  ipcMain.handle(channel, (_event, req: IpcRequest<C>) => handler(req));
}

/** Type-safe push from main to the renderer. */
function send<C extends IpcEventChannel>(channel: C, payload: IpcEventPayload<C>): void {
  mainWindow?.webContents.send(channel, payload);
}

function registerIpc(): void {
  handle('app:info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
  }));

  handle('project:get', () => project.getInfo());
  handle('project:refresh', () => project.getInfo());
  handle('template:list', () => project.listTemplates());
  handle('project:list', () => project.listProjects());
  handle('project:create', async (req) => {
    const info = await project.createProject(req.name, req.templateId);
    send('project:changed', info);
    return info;
  });
  handle('project:open', async (req) => {
    const info = await project.openProject(req.id);
    send('project:changed', info);
    return info;
  });
  handle('file:read', (req) => project.readFile(req.path));
  handle('file:write', (req) => project.writeFile(req.path, req.content, req.suppressWatch));

  handle('agent:harnesses', () => agents.listHarnesses());
  handle('mcp:endpoint', () => mcpEndpoint.info());
  handle('config:get', () => loadAgentSettings());
  handle('config:set', (patch) => saveAgentSettings(patch));
  handle('agent:start', (req) => agents.start(req));
  handle('agent:cancel', (req) => agents.cancel(req.runId));
  handle('agent:approval', (req) => agents.resolveApproval(req));

  // Stage 3 preview bridge: the renderer replies to main's `preview:request`s here,
  // and persists quick-action screenshots via the same ProjectManager capture path.
  handle('preview:result', (req) => preview.resolve(req));
  handle('preview:save-capture', (req) => project.saveCapture(dataUrlToBuffer(req.dataUrl)));
}

function createWindow(): void {
  // App icon (dev/Linux/Windows; macOS packaging uses the .icns from electron-builder).
  const iconPath = path.join(app.getAppPath(), 'build', 'icon.png');
  const icon = existsSync(iconPath) ? iconPath : undefined;

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#0e1013',
    title: 'Triangle',
    icon,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on('ready-to-show', () => mainWindow?.show());

  // Surface renderer errors/crashes in the dev terminal.
  if (isDev) {
    const wc = mainWindow.webContents;
    wc.on('console-message', (details) => {
      if (details.level === 'error') console.log('[renderer:error]', details.message);
    });
    wc.on('render-process-gone', (_e, details) =>
      console.error('[renderer] process gone:', details.reason),
    );
  }

  // Open external links in the user's browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(async () => {
  project = new ProjectManager((event) => send('project:file-changed', event));
  try {
    await project.ensureProject();
  } catch (err) {
    console.error('[main] failed to initialize project:', err);
  }
  preview = new PreviewBridge((req) => send('preview:request', req));
  toolBridge = new ToolBridgeServer();
  try {
    await toolBridge.start();
  } catch (err) {
    console.error('[main] tool bridge failed to start:', err);
  }
  // out/main/mcp.js sits next to this bundle; Codex (and external MCP clients
  // via the standalone endpoint) launch it as a subprocess.
  const mcpServerScriptPath = path.join(__dirname, 'mcp.js');
  mcpEndpoint = new McpEndpoint(project, preview, toolBridge, mcpServerScriptPath);
  try {
    await mcpEndpoint.start();
  } catch (err) {
    console.error('[main] MCP endpoint failed to start:', err);
  }
  agents = new AgentManager(
    project,
    preview,
    toolBridge,
    mcpServerScriptPath,
    (event) => send('agent:event', event),
    (req) => send('agent:approval-request', req),
    () => mcpEndpoint.serverConfig(),
  );

  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  agents?.disposeAll();
  preview?.disposeAll();
  mcpEndpoint?.stop();
  toolBridge?.stop();
  void project?.dispose();
});

if (isDev) {
  // Helpful during development.
  process.on('uncaughtException', (err) => console.error('[main] uncaught:', err));
  process.on('unhandledRejection', (err) => console.error('[main] unhandled rejection:', err));
}
