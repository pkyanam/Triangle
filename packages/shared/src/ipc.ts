/**
 * The single source of truth for the main <-> renderer IPC contract.
 *
 * - `IpcInvokeChannels` describe request/response (`ipcRenderer.invoke`) calls.
 * - `IpcEventChannels` describe push events (`webContents.send`) from main to renderer.
 *
 * Main (handlers), preload (bindings), and renderer (the `window.triangle` typings)
 * all import these so the contract can never drift.
 */
import type { FileChangeEvent, ProjectInfo } from './project.js';
import type {
  AgentEvent,
  AgentStartRequest,
  AgentStartResult,
  ApprovalDecision,
  ApprovalRequest,
  HarnessAvailability,
} from './agent.js';

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
  'file:read',
  'file:write',
  'app:info',
  'agent:harnesses',
  'agent:start',
  'agent:cancel',
  'agent:approval',
] as const satisfies readonly IpcInvokeChannel[];

export const EVENT_CHANNELS = [
  'project:file-changed',
  'project:changed',
  'agent:event',
  'agent:approval-request',
] as const satisfies readonly IpcEventChannel[];
