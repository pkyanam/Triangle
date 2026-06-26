/**
 * The single source of truth for the main <-> renderer IPC contract.
 *
 * - `IpcInvokeChannels` describe request/response (`ipcRenderer.invoke`) calls.
 * - `IpcEventChannels` describe push events (`webContents.send`) from main to renderer.
 *
 * Main (handlers), preload (bindings), and renderer (the `window.triangle` typings)
 * all import these so the contract can never drift.
 */
import type { AssetEntry, FileChangeEvent, ProjectInfo, ProjectSummary, SnapshotInfo, TemplateInfo } from './project.js';
import type { SessionRecord, SessionSummary } from './session.js';
import type {
  AgentEvent,
  AgentSettings,
  AgentStartRequest,
  AgentStartResult,
  ApprovalDecision,
  ApprovalRequest,
  HarnessAvailability,
} from './agent.js';
import type { McpEndpointInfo } from './endpoint.js';
import type { PreviewRequest, PreviewResult } from './preview.js';

/** Request/response channels invoked from the renderer. */
export interface IpcInvokeChannels {
  /** Load the currently active project (tree + manifest). */
  'project:get': {
    request: void;
    response: ProjectInfo;
  };
  /** Re-scan the project tree from disk. */
  'project:refresh': {
    request: void;
    response: ProjectInfo;
  };
  /** List the available project templates (the new-project gallery). */
  'template:list': {
    request: void;
    response: TemplateInfo[];
  };
  /** List all projects in the workspace (for the project switcher). */
  'project:list': {
    request: void;
    response: ProjectSummary[];
  };
  /**
   * Create a new project from a template and switch to it. The display name is
   * slugified into a traversal-safe directory id in the main process; the active
   * project changes (also pushed via `project:changed`).
   */
  'project:create': {
    request: { name: string; templateId: string };
    response: ProjectInfo;
  };
  /** Open (switch to) an existing project by id. Also pushed via `project:changed`. */
  'project:open': {
    request: { id: string };
    response: ProjectInfo;
  };
  /**
   * Export a project (default: the active one) to a `.zip` the user chooses via a
   * save dialog, excluding node_modules/.git/.triangle. The renderer never sees
   * raw fs — main packs and writes the archive.
   */
  'project:export': {
    request: { id?: string };
    response: { ok: boolean; path?: string; canceled?: boolean; error?: string };
  };
  /**
   * Export a project (default: the active one) as a single self-contained
   * `index.html` that runs by double-clicking in a browser — inlining the
   * Three.js runtime + OrbitControls + the project's entry module so no dev
   * server or install is needed. Main owns the save dialog (.html filter) and
   * the file write; the renderer never sees raw fs.
   */
  'project:export-html': {
    request: { id?: string };
    response: { ok: boolean; path?: string; canceled?: boolean; error?: string };
  };
  /**
   * Import a project from a user-picked `.zip` into a fresh workspace dir and
   * switch to it (also pushed via `project:changed`).
   */
  'project:import': {
    request: void;
    response: { ok: boolean; info?: ProjectInfo; canceled?: boolean; error?: string };
  };
  /**
   * Import a project from a user-picked directory (containing `triangle.json`)
   * into a fresh workspace dir and switch to it (also pushed via
   * `project:changed`). The renderer never sees a raw fs path — main owns the
   * open dialog and the copy.
   */
  'project:import-dir': {
    request: void;
    response: { ok: boolean; info?: ProjectInfo; canceled?: boolean; error?: string };
  };
  /**
   * Scan the active project for content assets (3D models, textures, HDRIs),
   * filtered by extension. Mirrors `project:get` but returns a flat asset list
   * for the Asset Browser rather than the full file tree.
   */
  'project:assets': {
    request: void;
    response: AssetEntry[];
  };
  /**
   * Read a binary project asset back as a data URL (used for image/texture
   * thumbnails in the Asset Browser). The renderer never sees raw fs.
   */
  'asset:data-url': {
    request: { path: string };
    response: { dataUrl: string };
  };
  /**
   * Open a native file picker for content assets and copy the chosen files into
   * the project's `assets/` directory, returning their new project-relative
   * paths. Main owns the dialog + copy.
   */
  'asset:import': {
    request: void;
    response: { ok: boolean; paths?: string[]; canceled?: boolean; error?: string };
  };
  /** Read a UTF-8 text file by project-relative path. */
  'file:read': {
    request: { path: string };
    response: { path: string; content: string };
  };
  /**
   * Write a UTF-8 text file by project-relative path.
   * Gated by the main process (Stage 1: no-op approval; later: human approval).
   *
   * `suppressWatch` marks the write as renderer-originated (e.g. the Monaco editor's
   * own save). The main process then swallows the watcher echo for that path so the
   * UI doesn't reload/clobber state it already holds. Agent/disk writes leave it unset
   * so the normal watcher-driven hot-reload path runs.
   */
  'file:write': {
    request: { path: string; content: string; suppressWatch?: boolean };
    response: { path: string; ok: boolean };
  };
  /** App metadata for the about/header surfaces. */
  'app:info': {
    request: void;
    response: { name: string; version: string; electron: string; node: string };
  };
  /** List agent harnesses with their runtime availability (keys/CLI present, …). */
  'agent:harnesses': {
    request: void;
    response: HarnessAvailability[];
  };
  /** The standalone Triangle MCP endpoint descriptor (ADR 0013). */
  'mcp:endpoint': {
    request: void;
    response: McpEndpointInfo;
  };
  /** Read the user-editable agent settings (per-harness models, ACP, …). */
  'config:get': {
    request: void;
    response: AgentSettings;
  };
  /** Persist a patch of agent settings; returns the new effective settings. */
  'config:set': {
    request: Partial<AgentSettings>;
    response: AgentSettings;
  };
  /** Start an agent run. Results stream back over the `agent:event` channel. */
  'agent:start': {
    request: AgentStartRequest;
    response: AgentStartResult;
  };
  /** Cancel an in-flight agent run. */
  'agent:cancel': {
    request: { runId: string };
    response: { ok: boolean };
  };
  /** Resolve a pending file-write approval (see `agent:approval-request`). */
  'agent:approval': {
    request: ApprovalDecision;
    response: { ok: boolean };
  };
  /** List Devin ACP sessions advertised by the agent. */
  'devin:sessions': {
    request: void;
    response: Array<{ sessionId: string; name?: string; createdAt?: string }>;
  };
  /** Log out of the Devin ACP agent. */
  'devin:logout': {
    request: void;
    response: { ok: boolean; error?: string };
  };
  /** List recorded agent sessions for the active project (newest first). */
  'session:list': {
    request: void;
    response: SessionSummary[];
  };
  /** Read one full session transcript by id (active project). */
  'session:get': {
    request: { id: string };
    response: SessionRecord | null;
  };
  /** Delete all recorded sessions for the active project. */
  'session:clear': {
    request: void;
    response: { ok: boolean };
  };
  /**
   * Iteration snapshots (Stage 5.5, ADR 0018). Each snapshot is a full copy of
   * the project tree under its gitignored `.triangle/snapshots/<id>/` directory.
   * All three are scoped to the active project; the renderer never sees raw fs
   * paths. A restore pushes `project:changed` so the UI reloads the tree.
   */
  'snapshot:list': {
    request: void;
    response: SnapshotInfo[];
  };
  'snapshot:create': {
    request: { name?: string };
    response: { ok: boolean; snapshot?: SnapshotInfo; error?: string };
  };
  'snapshot:restore': {
    request: { id: string };
    response: { ok: boolean; error?: string };
  };
  /**
   * The renderer's reply to a `preview:request` (Stage 3 preview bridge). The
   * active preview runtime services the request and returns the result here,
   * correlated by `requestId`. See ADR 0007.
   */
  'preview:result': {
    request: PreviewResult;
    response: { ok: boolean };
  };
  /**
   * Save a renderer-captured framebuffer (PNG data URL) to the project's
   * gitignored capture directory, returning its project-relative path. Backs
   * the "attach screenshot" quick-action; the agent screenshot tool saves via
   * the same `ProjectManager` path in main.
   */
  'preview:save-capture': {
    request: { dataUrl: string };
    response: { path: string };
  };
  /**
   * Run a Triangle agent tool manually from the UI (Stage 6 integration
   * testing). Bypasses the agent harness; approvals are auto-granted.
   */
  'tool:run': {
    request: { tool: string; args: Record<string, unknown> };
    response: { ok: boolean; result?: string; error?: string };
  };
  /**
   * Start the Hugging Face OAuth device-code flow. Returns the user code and
   * verification URL immediately so the renderer can display the code while the
   * user authorizes the device in their browser. Use `hf:poll-token` next.
   */
  'hf:device-code': {
    request: { clientId?: string; scope?: string };
    response: {
      ok: boolean;
      deviceCode?: string;
      userCode?: string;
      verificationUri?: string;
      verificationUriComplete?: string;
      error?: string;
    };
  };
  /**
   * Poll the HF token endpoint for the device code returned by `hf:device-code`.
   * On success the access token is persisted to the user config and the HF username
   * is returned.
   */
  'hf:poll-token': {
    request: { deviceCode: string; clientId?: string; scope?: string };
    response: { ok: boolean; username?: string; expiresAt?: number; error?: string };
  };
  /** Disconnect Hugging Face OAuth by clearing the persisted token. */
  'hf:disconnect': {
    request: void;
    response: { ok: boolean };
  };
  /** Current Hugging Face OAuth status (token presence, expiry, user info). */
  'hf:status': {
    request: void;
    response: { connected: boolean; username?: string; expiresAt?: number; scopes?: string };
  };
}

/** Events pushed from main to renderer. */
export interface IpcEventChannels {
  /** A watched file changed on disk. */
  'project:file-changed': FileChangeEvent;
  /** The active project changed (e.g. opened a different folder). */
  'project:changed': ProjectInfo;
  /** A streamed event from an in-flight agent run. */
  'agent:event': AgentEvent;
  /** A gated file write awaiting human approval. */
  'agent:approval-request': ApprovalRequest;
  /** A request from main for the active preview runtime to service (Stage 3). */
  'preview:request': PreviewRequest;
}

export type IpcInvokeChannel = keyof IpcInvokeChannels;
export type IpcEventChannel = keyof IpcEventChannels;

export type IpcRequest<C extends IpcInvokeChannel> = IpcInvokeChannels[C]['request'];
export type IpcResponse<C extends IpcInvokeChannel> = IpcInvokeChannels[C]['response'];
export type IpcEventPayload<C extends IpcEventChannel> = IpcEventChannels[C];

/** Frozen list of valid channel names, handy for runtime validation in main. */
export const INVOKE_CHANNELS = [
  'project:get',
  'project:refresh',
  'template:list',
  'project:list',
  'project:create',
  'project:open',
  'project:export',
  'project:export-html',
  'project:import',
  'project:import-dir',
  'project:assets',
  'asset:data-url',
  'asset:import',
  'file:read',
  'file:write',
  'app:info',
  'agent:harnesses',
  'mcp:endpoint',
  'config:get',
  'config:set',
  'agent:start',
  'agent:cancel',
  'agent:approval',
  'devin:sessions',
  'devin:logout',
  'session:list',
  'session:get',
  'session:clear',
  'snapshot:list',
  'snapshot:create',
  'snapshot:restore',
  'preview:result',
  'preview:save-capture',
  'tool:run',
  'hf:device-code',
  'hf:poll-token',
  'hf:disconnect',
  'hf:status',
] as const satisfies readonly IpcInvokeChannel[];

export const EVENT_CHANNELS = [
  'project:file-changed',
  'project:changed',
  'agent:event',
  'agent:approval-request',
  'preview:request',
] as const satisfies readonly IpcEventChannel[];
