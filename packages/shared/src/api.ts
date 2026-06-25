/**
 * The `window.triangle` surface exposed by the preload bridge. This is the typed
 * client view of the IPC contract (see `ipc.ts`). Preload implements it; the renderer
 * consumes it via a global `Window` augmentation.
 */
import type { IpcRequest, IpcResponse } from './ipc.js';
import type { FileChangeEvent, ProjectInfo, ProjectSummary, TemplateInfo } from './project.js';
import type {
  AgentEvent,
  AgentStartRequest,
  AgentStartResult,
  ApprovalDecision,
  ApprovalRequest,
  HarnessAvailability,
} from './agent.js';
import type { McpEndpointInfo } from './endpoint.js';
import type { PreviewRequest, PreviewResult } from './preview.js';

/** Unsubscribe handle returned by event subscriptions. */
export type Unsubscribe = () => void;

export interface TriangleApi {
  app: {
    info: () => Promise<IpcResponse<'app:info'>>;
  };
  project: {
    get: () => Promise<ProjectInfo>;
    refresh: () => Promise<ProjectInfo>;
    /** List every project in the workspace (for the switcher). */
    list: () => Promise<ProjectSummary[]>;
    /** Available templates for the new-project gallery. */
    templates: () => Promise<TemplateInfo[]>;
    /** Create a new project from a template and switch to it. */
    create: (req: { name: string; templateId: string }) => Promise<ProjectInfo>;
    /** Open (switch to) an existing project by id. */
    open: (id: string) => Promise<ProjectInfo>;
    /** Export a project (default: active) to a user-chosen `.zip`. */
    export: (id?: string) => Promise<IpcResponse<'project:export'>>;
    /** Import a project from a user-picked `.zip` and switch to it. */
    import: () => Promise<IpcResponse<'project:import'>>;
    /** Subscribe to file-change events for the active project. */
    onFileChanged: (cb: (event: FileChangeEvent) => void) => Unsubscribe;
    /** Subscribe to active-project changes. */
    onChanged: (cb: (info: ProjectInfo) => void) => Unsubscribe;
  };
  file: {
    read: (path: string) => Promise<IpcResponse<'file:read'>>;
    write: (req: IpcRequest<'file:write'>) => Promise<IpcResponse<'file:write'>>;
  };
  agent: {
    /** Harnesses with live availability (key/CLI presence). */
    harnesses: () => Promise<HarnessAvailability[]>;
    /** Start a run; events arrive via `onEvent`. */
    start: (req: AgentStartRequest) => Promise<AgentStartResult>;
    /** Cancel an in-flight run. */
    cancel: (runId: string) => Promise<{ ok: boolean }>;
    /** Resolve a pending write approval. */
    approve: (decision: ApprovalDecision) => Promise<{ ok: boolean }>;
    /** Subscribe to streamed run events. */
    onEvent: (cb: (event: AgentEvent) => void) => Unsubscribe;
    /** Subscribe to write-approval prompts. */
    onApprovalRequest: (cb: (req: ApprovalRequest) => void) => Unsubscribe;
  };
  /** Standalone MCP endpoint (ADR 0013): how external MCP clients connect to Triangle. */
  mcp: {
    endpoint: () => Promise<McpEndpointInfo>;
  };
  /** User-editable agent settings (per-harness models, ACP agent, …). */
  config: {
    get: () => Promise<IpcResponse<'config:get'>>;
    set: (patch: IpcRequest<'config:set'>) => Promise<IpcResponse<'config:set'>>;
  };
  /** Stage 3 preview bridge — connects the agent layer to the live runtime. */
  preview: {
    /**
     * Subscribe to requests issued by main (screenshot/scene/perf/shader). The
     * active preview runtime services each and replies via {@link result}.
     */
    onRequest: (cb: (req: PreviewRequest) => void) => Unsubscribe;
    /** Reply to a `preview:request`, correlated by `requestId`. */
    result: (result: PreviewResult) => Promise<{ ok: boolean }>;
    /** Persist a captured PNG (data URL) to the project, returning its path. */
    saveCapture: (dataUrl: string) => Promise<IpcResponse<'preview:save-capture'>>;
  };
}
