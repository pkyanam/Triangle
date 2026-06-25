/**
 * The single source of truth for the main <-> renderer IPC contract.
 *
 * - `IpcInvokeChannels` describe request/response (`ipcRenderer.invoke`) calls.
 * - `IpcEventChannels` describe push events (`webContents.send`) from main to renderer.
 *
 * Main (handlers), preload (bindings), and renderer (the `window.triangle` typings)
 * all import these so the contract can never drift.
 */
import type { FileChangeEvent, ProjectInfo, ProjectSummary, TemplateInfo } from './project.js';
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
  'preview:result',
  'preview:save-capture',
] as const satisfies readonly IpcInvokeChannel[];

export const EVENT_CHANNELS = [
  'project:file-changed',
  'project:changed',
  'agent:event',
  'agent:approval-request',
  'preview:request',
] as const satisfies readonly IpcEventChannel[];
