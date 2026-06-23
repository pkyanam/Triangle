import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import type {
  IpcEventChannel,
  IpcEventPayload,
  IpcInvokeChannel,
  IpcRequest,
  IpcResponse,
} from '@triangle/shared';
import { ProjectManager } from './project.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !!process.env['ELECTRON_RENDERER_URL'];

let mainWindow: BrowserWindow | null = null;
let project: ProjectManager;

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
  handle('file:read', (req) => project.readFile(req.path));
  handle('file:write', (req) => project.writeFile(req.path, req.content));
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#0e1013',
    title: 'Triangle',
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
  void project?.dispose();
});

if (isDev) {
  // Helpful during development.
  process.on('uncaughtException', (err) => console.error('[main] uncaught:', err));
  process.on('unhandledRejection', (err) => console.error('[main] unhandled rejection:', err));
}
