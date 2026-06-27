import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
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
import { listDevinSessions, logoutDevin } from './agent/devin.js';
import { PreviewBridge } from './preview-bridge.js';
import { ToolBridgeServer, dispatchTool } from './tool-bridge.js';
import { McpEndpoint } from './mcp-endpoint.js';
import { SessionStore } from './session-store.js';
import { AutomationHost } from './automation.js';
import { VerificationHost } from './verification.js';
import { createToolset } from './agent/tools.js';
import { hfDeviceCode, hfDisconnect, hfPollToken, hfStatus } from './hf-oauth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !!process.env['ELECTRON_RENDERER_URL'];

// Packaged macOS apps launched from Finder/Dock inherit a minimal system PATH
// (typically /usr/bin:/bin:/usr/sbin:/sbin) that excludes user-level bin dirs
// where CLIs like `devin` (~/.local/bin), `codex` (~/.nvm/...), homebrew
// (/opt/homebrew/bin), etc. are installed. In dev the app inherits the shell's
// full PATH so this isn't needed, but a packaged .app can't find any of them
// without this augmentation. We prepend the common locations so the harness
// availability probes (which spawn `devin --version`, `codex --version`, etc.)
// can actually resolve the binaries.
if (!isDev) {
  const home = process.env['HOME'] || '/Users/Shared';
  const extraPaths = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    path.join(home, '.local', 'bin'),
    path.join(home, 'Library', 'pnpm'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.cargo', 'bin'),
    path.join(home, '.deno', 'bin'),
  ];
  // nvm installs Node version-specific bin dirs under ~/.nvm/versions/node/*.
  // Add every version's bin dir so CLIs installed via `npm i -g` (like codex)
  // are found regardless of which Node version is active.
  const nvmDir = path.join(home, '.nvm', 'versions', 'node');
  if (existsSync(nvmDir)) {
    try {
      for (const version of readdirSync(nvmDir)) {
        const binDir = path.join(nvmDir, version, 'bin');
        if (existsSync(binDir)) extraPaths.push(binDir);
      }
    } catch {
      /* nvm dir unreadable — skip. */
    }
  }
  const currentPath = process.env['PATH'] ?? '';
  const seen = new Set(currentPath.split(path.delimiter).filter(Boolean));
  const additions = extraPaths.filter((p) => !seen.has(p) && existsSync(p));
  if (additions.length > 0) {
    process.env['PATH'] = [...additions, currentPath].filter(Boolean).join(path.delimiter);
  }
}

// Force the app name to "Triangle" everywhere (menu bar, About, app:info IPC).
// In dev, Electron defaults to "Electron" — this overrides it so the brand is
// correct even when running `npm run dev`.
app.setName('Triangle');

// In dev on macOS the dock shows the Electron logo; replace it with the Triangle
// icon. Packaged builds get the icon baked in by electron-builder.
if (isDev && process.platform === 'darwin') {
  const devIconPath = path.join(app.getAppPath(), 'build', 'icon.png');
  if (existsSync(devIconPath)) {
    try {
      app.dock?.setIcon(devIconPath);
    } catch {
      /* dock.setIcon may be unavailable on some platforms — ignore. */
    }
  }
}

let mainWindow: BrowserWindow | null = null;
let project: ProjectManager;
let agents: AgentManager;
let preview: PreviewBridge;
let toolBridge: ToolBridgeServer;
let mcpEndpoint: McpEndpoint;
let sessions: SessionStore;
let automation: AutomationHost;
let verification: VerificationHost;

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

/**
 * Push `project:changed` to the renderer and re-hydrate the automation engine
 * for the new active project (V2, ADR 0029). Called wherever the active project
 * changes (create/open/import/restore).
 */
function notifyProjectChanged(info: IpcEventPayload<'project:changed'>): void {
  send('project:changed', info);
  void automation?.reloadForProject();
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
    notifyProjectChanged(info);
    return info;
  });
  handle('project:open', async (req) => {
    const info = await project.openProject(req.id);
    notifyProjectChanged(info);
    return info;
  });
  handle('project:export', async (req) => {
    try {
      const { bytes, filename } = await project.exportProject(req.id);
      const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
      const result = await dialog.showSaveDialog(win!, {
        title: 'Export Triangle project',
        defaultPath: filename,
        filters: [{ name: 'Zip archive', extensions: ['zip'] }],
      });
      if (result.canceled || !result.filePath) return { ok: false, canceled: true };
      await fsp.writeFile(result.filePath, Buffer.from(bytes));
      return { ok: true, path: result.filePath };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
  handle('project:export-html', async (req) => {
    try {
      const { html, filename } = await project.exportProjectHtml(req.id);
      const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
      const result = await dialog.showSaveDialog(win!, {
        title: 'Export standalone HTML',
        defaultPath: filename,
        filters: [{ name: 'HTML document', extensions: ['html'] }],
      });
      if (result.canceled || !result.filePath) return { ok: false, canceled: true };
      await fsp.writeFile(result.filePath, html, 'utf8');
      return { ok: true, path: result.filePath };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
  handle('project:import', async () => {
    try {
      const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
      const result = await dialog.showOpenDialog(win!, {
        title: 'Import Triangle project',
        properties: ['openFile'],
        filters: [{ name: 'Zip archive', extensions: ['zip'] }],
      });
      if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
      const bytes = new Uint8Array(await fsp.readFile(result.filePaths[0]));
      const info = await project.importProjectFromZip(bytes);
      notifyProjectChanged(info);
      return { ok: true, info };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
  handle('project:import-dir', async () => {
    try {
      const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
      const result = await dialog.showOpenDialog(win!, {
        title: 'Import Triangle project folder',
        properties: ['openDirectory'],
      });
      if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
      const info = await project.importProjectFromDir(result.filePaths[0]);
      notifyProjectChanged(info);
      return { ok: true, info };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
  handle('project:assets', () => project.listAssets());
  handle('asset:data-url', (req) => project.assetDataUrl(req.path));
  handle('asset:import', async () => {
    try {
      const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
      const result = await dialog.showOpenDialog(win!, {
        title: 'Import asset',
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: '3D models', extensions: ['glb', 'gltf', 'obj', 'usdz', 'fbx'] },
          { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
          { name: 'Environment maps', extensions: ['hdr', 'exr'] },
          { name: 'All files', extensions: ['*'] },
        ],
      });
      if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
      const paths: string[] = [];
      for (const filePath of result.filePaths) paths.push(await project.copyAssetInto(filePath));
      return { ok: true, paths };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
  handle('file:read', (req) => project.readFile(req.path));
  handle('file:write', (req) => project.writeFile(req.path, req.content, req.suppressWatch));

  handle('agent:harnesses', () => agents.listHarnesses());
  handle('mcp:endpoint', () => mcpEndpoint.info());
  handle('config:get', async () => loadAgentSettings());
  handle('config:set', async (patch) => saveAgentSettings(patch));
  handle('agent:start', (req) => agents.start(req));
  handle('agent:cancel', (req) => agents.cancel(req.runId));
  handle('agent:approval', (req) => agents.resolveApproval(req));

  // Devin ACP lifecycle helpers.
  handle('devin:sessions', async () => {
    const settings = await loadAgentSettings();
    return listDevinSessions({ devinPath: settings.devinPath });
  });
  handle('devin:logout', async () => {
    const settings = await loadAgentSettings();
    return logoutDevin({ devinPath: settings.devinPath });
  });

  // Session history (ADR 0016) — scoped to the active project.
  handle('session:list', () => sessions.list(project.getActiveId()));
  handle('session:get', (req) => sessions.get(project.getActiveId(), req.id));
  handle('session:clear', async () => {
    await sessions.clear(project.getActiveId());
    return { ok: true };
  });

  // Iteration snapshots (Stage 5.5, ADR 0018) — scoped to the active project.
  // A restore rewrites the project tree, so we re-activate (rebind the watcher)
  // and push `project:changed` so the renderer reloads the tree + entry.
  handle('snapshot:list', () => project.listSnapshots());
  handle('snapshot:create', async (req) => {
    try {
      const snapshot = await project.createSnapshot(req.name);
      return { ok: true, snapshot };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
  handle('snapshot:restore', async (req) => {
    try {
      await project.restoreSnapshot(req.id);
      const info = await project.reactivateActive();
      notifyProjectChanged(info);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // Stage 3 preview bridge: the renderer replies to main's `preview:request`s here,
  // and persists quick-action screenshots via the same ProjectManager capture path.
  handle('preview:result', (req) => preview.resolve(req));
  // V0 preview event bus (ADR 0027): the renderer's preview runtime pushes
  // structured events (shader-error, runtime-exception, perf-threshold, …) to
  // main. V2 (ADR 0029) routes these into the AutomationEngine so event-driven
  // automations (e.g. the Shader Error Auto-Fixer) fire on a matching trigger.
  handle('preview:event', (req) => {
    automation?.onPreviewEvent(req);
    return { ok: true };
  });
  handle('preview:save-capture', (req) => project.saveCapture(dataUrlToBuffer(req.dataUrl)));

  // Stage 6: manual tool runner for integration testing from the UI.
  handle('tool:run', async (req) => {
    try {
      // Resolve HF credentials from the user config so the Asset Generator dialog
      // (which calls this channel directly, outside an agent run) honours an
      // existing Hugging Face OAuth connection / hfToken setting / HF_TOKEN env.
      const settings = await loadAgentSettings();
      const toolset = createToolset({
        project,
        preview,
        approveWrite: async () => true,
        hfToken: settings.hfToken,
        hfOAuthToken: settings.hfOAuthToken,
        hfOAuthExpiresAt: settings.hfOAuthExpiresAt,
        emitTrace: () => {},
      });
      const result = await dispatchTool(toolset, req.tool, req.args ?? {});
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // Stage 6: Hugging Face OAuth lifecycle for Spaces integration.
  handle('hf:device-code', async (req) => {
    const res = await hfDeviceCode(req);
    if (res.ok && res.verificationUriComplete) {
      void shell.openExternal(res.verificationUriComplete);
    } else if (res.ok && res.verificationUri) {
      void shell.openExternal(res.verificationUri);
    }
    return res;
  });
  handle('hf:poll-token', (req) => hfPollToken(req));
  handle('hf:disconnect', () => hfDisconnect());
  handle('hf:status', () => hfStatus());

  // V2 automation engine (ADR 0029): built-in playbooks + user automations,
  // event-driven or manual firing, scoped through V1's approval gate.
  handle('automation:list', () => automation.list());
  handle('automation:create', (req) => automation.create(req));
  handle('automation:update', (req) => automation.update(req));
  handle('automation:delete', (req) => automation.delete(req));
  handle('automation:run', (req) => automation.run(req));
  handle('automation:enable', (req) => automation.enable(req));

  // V3 verification pipeline (ADR 0030): run checks against the live preview,
  // capture / list baselines, and read the most recent report. The host owns
  // the pipeline + per-project baselines + auto-rollback-on-fail.
  handle('verification:run', (req) => verification.run(req));
  handle('verification:baseline-set', (req) => verification.setBaseline(req.label));
  handle('verification:baseline-list', () => verification.listBaselines());
  handle('verification:report-get', () => verification.getReport());
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
  // File-change callback: push to the renderer AND (once instantiated) the V2
  // automation engine so file-change triggers fire. The host is created after
  // `agents` below; the optional chaining keeps the callback safe until then.
  project = new ProjectManager((event) => {
    send('project:file-changed', event);
    automation?.onFileChange(event);
  });
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
  // The Triangle MCP server entry that Codex (and external MCP clients via the
  // standalone endpoint) launch as a node subprocess. In dev it sits next to this
  // bundle (out/main/mcp.js) with its shared chunk at out/main/chunks/. In a
  // packaged build it can't run from inside app.asar (ESM + asar is brittle for a
  // spawned process), so electron-builder ships mcp.js + its chunks/ sibling +
  // an ESM `package.json` marker to <resources>/mcp via extraResources, and we
  // resolve it from process.resourcesPath. See ADR 0017 (and ADR 0008/0013).
  const mcpServerScriptPath = app.isPackaged
    ? path.join(process.resourcesPath, 'mcp', 'mcp.js')
    : path.join(__dirname, 'mcp.js');
  mcpEndpoint = new McpEndpoint(project, preview, toolBridge, mcpServerScriptPath);
  try {
    await mcpEndpoint.start();
  } catch (err) {
    console.error('[main] MCP endpoint failed to start:', err);
  }
  sessions = new SessionStore();
  // V3 (ADR 0030): the verification host. Owns the pipeline + per-project
  // baselines; AgentManager calls `verifyAfterRun` after a run's writes land,
  // and the `verification:*` IPC handlers below expose run/baseline/report to
  // the Visual QA panel. Rollback restores the last snapshot via `project`.
  verification = new VerificationHost(
    project,
    preview,
    sessions,
    (report) => send('verification:report', report),
    async () => {
      // After a rollback the on-disk tree changed underneath the watcher;
      // reactivating the active project re-reads it so the UI stays in sync.
      try {
        await project.reactivateActive();
      } catch (err) {
        console.warn('[main] post-rollback reactivate failed:', err);
      }
    },
  );
  agents = new AgentManager(
    project,
    preview,
    toolBridge,
    mcpServerScriptPath,
    sessions,
    (event) => send('agent:event', event),
    (req) => send('agent:approval-request', req),
    () => mcpEndpoint.serverConfig(),
    verification,
  );
  // V2 (ADR 0029): the automation engine. Subscribes to V0 preview events +
  // the file watcher + a scheduler; fires matching automations through the
  // scoped approval gate. `automation:triggered` is pushed to the renderer.
  automation = new AutomationHost(project, agents, (event) => send('automation:triggered', event));
  try {
    await automation.init();
  } catch (err) {
    console.error('[main] automation engine failed to initialize:', err);
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
  agents?.disposeAll();
  automation?.dispose();
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
