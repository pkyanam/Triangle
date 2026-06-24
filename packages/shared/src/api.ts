/**
 * The `window.triangle` surface exposed by the preload bridge. This is the typed
 * client view of the IPC contract (see `ipc.ts`). Preload implements it; the renderer
 * consumes it via a global `Window` augmentation.
 */
import type { IpcRequest, IpcResponse } from './ipc.js';
import type { FileChangeEvent, ProjectInfo } from './project.js';
import type {
  AgentEvent,
  AgentStartRequest,
  AgentStartResult,
  ApprovalDecision,
  ApprovalRequest,
  HarnessAvailability,
} from './agent.js';
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
