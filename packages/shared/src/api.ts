/**
 * The `window.triangle` surface exposed by the preload bridge. This is the typed
 * client view of the IPC contract (see `ipc.ts`). Preload implements it; the renderer
 * consumes it via a global `Window` augmentation.
 */
import type { IpcRequest, IpcResponse } from './ipc.js';
import type { AssetEntry, FileChangeEvent, ProjectInfo, ProjectSummary, SnapshotInfo, TemplateInfo } from './project.js';
import type { SessionRecord, SessionSummary } from './session.js';
import type {
  AgentEvent,
  AgentStartRequest,
  AgentStartResult,
  ApprovalDecision,
  ApprovalRequest,
  HarnessAvailability,
} from './agent.js';
import type { McpEndpointInfo } from './endpoint.js';
import type { PreviewEvent, PreviewRequest, PreviewResult } from './preview.js';
import type {
  Automation,
  AutomationPatch,
  AutomationRunResult,
  AutomationTriggeredEvent,
  NewAutomation,
  SuccessCriteria,
} from './automation.js';
import type {
  Baseline,
  VerificationCheckSpec,
  VerificationReport,
} from './verification.js';
import type { MemoryEntry, MemoryNote, Playbook } from './context.js';

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
    /** Export a project (default: active) as a self-contained `index.html`. */
    exportHtml: (id?: string) => Promise<IpcResponse<'project:export-html'>>;
    /** Import a project from a user-picked `.zip` and switch to it. */
    import: () => Promise<IpcResponse<'project:import'>>;
    /** Import a project from a user-picked folder (containing triangle.json). */
    importDir: () => Promise<IpcResponse<'project:import-dir'>>;
    /** Subscribe to file-change events for the active project. */
    onFileChanged: (cb: (event: FileChangeEvent) => void) => Unsubscribe;
    /** Subscribe to active-project changes. */
    onChanged: (cb: (info: ProjectInfo) => void) => Unsubscribe;
    /** Scan the active project for content assets (models/textures/HDRIs). */
    assets: () => Promise<AssetEntry[]>;
  };
  file: {
    read: (path: string) => Promise<IpcResponse<'file:read'>>;
    write: (req: IpcRequest<'file:write'>) => Promise<IpcResponse<'file:write'>>;
  };
  /** Content-asset helpers backing the Asset Browser. */
  asset: {
    /** Read a binary asset back as a data URL (image/texture thumbnails). */
    dataUrl: (path: string) => Promise<IpcResponse<'asset:data-url'>>;
    /** Open a native picker and copy chosen files into the project `assets/`. */
    import: () => Promise<IpcResponse<'asset:import'>>;
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
  /** Devin ACP lifecycle helpers. */
  devin: {
    /** List resumable ACP sessions advertised by the agent. */
    sessions: () => Promise<Array<{ sessionId: string; name?: string; createdAt?: string }>>;
    /** Log out of the Devin ACP agent. */
    logout: () => Promise<{ ok: boolean; error?: string }>;
  };
  /** Persisted agent session history for the active project (ADR 0016). */
  session: {
    /** List recorded sessions (newest first). */
    list: () => Promise<SessionSummary[]>;
    /** Read one full session transcript by id. */
    get: (id: string) => Promise<SessionRecord | null>;
    /** Delete all recorded sessions for the active project. */
    clear: () => Promise<{ ok: boolean }>;
  };
  /**
   * Iteration snapshots for the active project (Stage 5.5, ADR 0018). Each
   * snapshot is a full copy of the project tree under its gitignored
   * `.triangle/snapshots/<id>/` directory; restore copies it back and pushes
   * `project:changed`.
   */
  snapshot: {
    /** List snapshots (newest first). */
    list: () => Promise<SnapshotInfo[]>;
    /** Create a snapshot (optional label; auto-generated otherwise). */
    create: (name?: string) => Promise<IpcResponse<'snapshot:create'>>;
    /** Restore a snapshot by id (reloads the active project). */
    restore: (id: string) => Promise<IpcResponse<'snapshot:restore'>>;
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
    /**
     * V0 preview event bus (ADR 0027): push a structured preview event to main
     * so the automation engine (V2) and audit spine can subscribe.
     */
    event: (event: PreviewEvent) => Promise<{ ok: boolean }>;
    /** Persist a captured PNG (data URL) to the project, returning its path. */
    saveCapture: (dataUrl: string) => Promise<IpcResponse<'preview:save-capture'>>;
  };
  /** Stage 6 manual tool runner — integration testing UI for agent tools. */
  tool: {
    run: (req: IpcRequest<'tool:run'>) => Promise<IpcResponse<'tool:run'>>;
  };
  /** Stage 6 Hugging Face OAuth lifecycle — connects the desktop app to Spaces. */
  hf: {
    deviceCode: (req: IpcRequest<'hf:device-code'>) => Promise<IpcResponse<'hf:device-code'>>;
    pollToken: (req: IpcRequest<'hf:poll-token'>) => Promise<IpcResponse<'hf:poll-token'>>;
    disconnect: () => Promise<IpcResponse<'hf:disconnect'>>;
    status: () => Promise<IpcResponse<'hf:status'>>;
  };
  /**
   * V2 automation engine (ADR 0029): named, reusable automations with triggers,
   * conditions, scoped plans, and success criteria. Built-in playbooks ship in
   * `templates/playbooks/`; user automations persist per-project.
   */
  automation: {
    /** List all automations (built-in + user) for the active project. */
    list: () => Promise<Automation[]>;
    /** Create a user automation (id assigned by main). */
    create: (automation: NewAutomation) => Promise<IpcResponse<'automation:create'>>;
    /** Update a user automation (built-ins reject plan/scope changes). */
    update: (id: string, patch: AutomationPatch) => Promise<IpcResponse<'automation:update'>>;
    /** Delete a user automation (built-ins are not deletable). */
    delete: (id: string) => Promise<IpcResponse<'automation:delete'>>;
    /** Manually fire an automation by id (the `command` trigger path). */
    run: (id: string) => Promise<AutomationRunResult>;
    /** Enable or disable an automation. */
    enable: (id: string, enabled: boolean) => Promise<IpcResponse<'automation:enable'>>;
    /** Subscribe to `automation:triggered` push events. */
    onTriggered: (cb: (event: AutomationTriggeredEvent) => void) => Unsubscribe;
  };
  /**
   * V3 verification pipeline (ADR 0030): runs shader-compile + perf-delta +
   * scene-integrity + visual-regression checks against the live preview,
   * compares against a per-project baseline, and (on a rollback-on-fail check
   * failing) auto-restores the last verified state. Reports are pushed over
   * `onReport` and recorded on the session audit spine.
   */
  verification: {
    /** Run the pipeline (optionally with a batch to apply first). */
    run: (req: {
      checks?: VerificationCheckSpec[];
      changes?: { path: string; kind: 'create' | 'update' | 'delete'; newContent?: string }[];
      criteria?: SuccessCriteria;
      baselineId?: string;
    }) => Promise<IpcResponse<'verification:run'>>;
    /** Capture the current state as a per-project baseline. */
    setBaseline: (label?: string) => Promise<IpcResponse<'verification:baseline-set'>>;
    /** List per-project baselines (newest first). */
    listBaselines: () => Promise<Baseline[]>;
    /** Read the most recent verification report for the active project. */
    getReport: () => Promise<VerificationReport | null>;
    /** Subscribe to `verification:report` push events. */
    onReport: (cb: (report: VerificationReport) => void) => Unsubscribe;
  };
  /**
   * V4 (ADR 0031): project memory — a project-local store (SQLite under
   * `.triangle/memory/`) indexing session transcripts + user notes with a
   * TF-IDF index. `recall` pulls the most relevant past outcomes into a run's
   * context; `addNote` / `listNotes` / `deleteNote` back the Memory panel.
   */
  memory: {
    /** Recall relevant memory entries for a run prompt (bounded by maxEntries). */
    recall: (query: string, maxEntries?: number) => Promise<MemoryEntry[]>;
    /** Free-text search over project memory (UI-facing). */
    search: (query: string, maxEntries?: number) => Promise<MemoryEntry[]>;
    /** Add a project-scoped user note. */
    addNote: (text: string) => Promise<IpcResponse<'memory:add-note'>>;
    /** List all user notes (newest first). */
    listNotes: () => Promise<MemoryNote[]>;
    /** Delete a user note by id. */
    deleteNote: (id: string) => Promise<{ ok: boolean }>;
  };
  /**
   * V4 (ADR 0031): the playbooks library — versioned, structured playbooks
   * (built-in + user) the context pipeline matches against a run's prompt.
   */
  playbook: {
    /** List all playbooks (built-in + user). */
    list: () => Promise<Playbook[]>;
    /** Read one playbook by id, when present. */
    get: (id: string) => Promise<Playbook | null>;
  };
}
