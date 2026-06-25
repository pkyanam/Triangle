import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera,
  FolderGit2,
  Gauge,
  History,
  ListTree,
  Send,
  Settings2,
  ShieldCheck,
  Square,
  Terminal,
  TriangleAlert,
} from 'lucide-react';
import {
  type AgentEvent,
  type ApprovalRequest,
  type ApprovalScope,
  type ChatMessage,
  type HarnessAvailability,
  type HarnessId,
  type ToolCallTrace,
} from '@triangle/shared';
import { HarnessPicker } from './HarnessPicker.js';
import { HarnessConfig } from './HarnessConfig.js';
import { SessionHistory } from './SessionHistory.js';
import { DiffView } from './DiffView.js';
import {
  activePerformanceSnapshot,
  captureScreenshotPath,
  describeActiveScene,
} from '../preview/bridge.js';

let idCounter = 0;
const nextId = (): string => `m${++idCounter}`;
const newRunId = (): string => `run_${Date.now()}_${++idCounter}`;

const GREETING: ChatMessage = {
  id: nextId(),
  role: 'system',
  content:
    'Triangle agent ready. Pick a harness: Devin CLI (the preferred default when installed + ' +
    'authenticated, driven over ACP) leads; the Mock agent works with no setup; Claude Agent ' +
    'SDK needs ANTHROPIC_API_KEY; Codex CLI needs the `codex` binary. The agent edits project ' +
    'files (gated by approval unless auto-approve is on) and the preview hot-reloads on save. ' +
    'Switch or create projects from the title bar; every run is saved to History and survives restarts.',
  timestamp: Date.now(),
};

interface AgentPanelProps {
  projectName: string;
  /** Active project id — used to scope session history and reset the chat on switch. */
  projectId: string;
}

export function AgentPanel({ projectName, projectId }: AgentPanelProps): React.JSX.Element {
  const [harness, setHarness] = useState<HarnessId>('mock');
  const [availability, setAvailability] = useState<HarnessAvailability[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([GREETING]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [autoApprove, setAutoApprove] = useState(false);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const runRef = useRef<string | null>(null);
  // Once the user explicitly picks a harness, stop auto-selecting a default.
  const userPickedRef = useRef(false);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, approval]);

  const refreshHarnesses = useCallback(() => {
    void window.triangle.agent.harnesses().then(setAvailability);
  }, []);

  // Load runtime harness availability + the persisted auto-approve default.
  useEffect(() => {
    refreshHarnesses();
    void window.triangle.config.get().then((s) => {
      if (typeof s.autoApproveWrites === 'boolean') setAutoApprove(s.autoApproveWrites);
    });
  }, [refreshHarnesses]);

  // Prefer Devin as the default harness when it's fully ready (binary present +
  // authenticated → available with no setup reason). Falls back gracefully to the
  // initial `mock` selection otherwise, and never overrides an explicit user pick.
  useEffect(() => {
    if (userPickedRef.current || availability.length === 0) return;
    const devin = availability.find((a) => a.id === 'devin');
    if (devin?.available && !devin.reason) setHarness('devin');
  }, [availability]);

  const pickHarness = useCallback((id: HarnessId) => {
    userPickedRef.current = true;
    setHarness(id);
  }, []);

  // Switching projects resets the live chat (each project has its own history),
  // dismisses any pending approval, and leaves the history view.
  useEffect(() => {
    setMessages([GREETING]);
    setApproval(null);
    setShowHistory(false);
    runRef.current = null;
    setBusy(false);
  }, [projectId]);

  /** Insert or update a message by id. */
  const upsert = useCallback((msg: ChatMessage) => {
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === msg.id);
      if (idx === -1) return [...prev, msg];
      const next = [...prev];
      next[idx] = { ...next[idx], ...msg };
      return next;
    });
  }, []);

  /** Merge a tool trace into a per-run "tool activity" bubble. */
  const upsertTrace = useCallback((runId: string, trace: ToolCallTrace) => {
    const id = `tools:${runId}`;
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === id);
      if (idx === -1) {
        return [
          ...prev,
          { id, role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [trace] },
        ];
      }
      const existing = prev[idx];
      const calls = existing.toolCalls ? [...existing.toolCalls] : [];
      const tIdx = calls.findIndex((c) => c.id === trace.id);
      if (tIdx === -1) calls.push(trace);
      else calls[tIdx] = trace;
      const next = [...prev];
      next[idx] = { ...existing, toolCalls: calls };
      return next;
    });
  }, []);

  // Subscribe to streamed run events + approval prompts.
  useEffect(() => {
    const offEvent = window.triangle.agent.onEvent((event: AgentEvent) => {
      if (event.runId !== runRef.current) return;
      switch (event.type) {
        case 'assistant':
          upsert({
            id: `a:${event.runId}:${event.messageId}`,
            role: 'assistant',
            content: event.text,
            timestamp: Date.now(),
          });
          break;
        case 'tool':
          upsertTrace(event.runId, event.trace);
          break;
        case 'log':
          upsert({
            id: `log:${event.runId}`,
            role: 'system',
            content: event.text,
            timestamp: Date.now(),
          });
          break;
        case 'status':
          if (event.status === 'error') {
            upsert({
              id: `err:${event.runId}`,
              role: 'system',
              content: `Error: ${event.message ?? 'agent run failed.'}`,
              timestamp: Date.now(),
            });
          }
          if (event.status !== 'started') {
            setBusy(false);
            runRef.current = null;
          }
          break;
      }
    });

    const offApproval = window.triangle.agent.onApprovalRequest((req) => {
      if (req.runId !== runRef.current) {
        void window.triangle.agent.approve({ approvalId: req.approvalId, approved: false });
        return;
      }
      setApproval(req);
    });

    return () => {
      offEvent();
      offApproval();
    };
  }, [upsert, upsertTrace]);

  const send = (): void => {
    const text = input.trim();
    if (!text || busy) return;
    const runId = newRunId();
    runRef.current = runId;
    setMessages((m) => [
      ...m,
      { id: nextId(), role: 'user', content: text, timestamp: Date.now() },
    ]);
    setInput('');
    setBusy(true);

    void window.triangle.agent
      .start({ runId, harness, prompt: text, autoApproveWrites: autoApprove })
      .then((res) => {
        if (!res.accepted) {
          upsert({
            id: `err:${runId}`,
            role: 'system',
            content: `Could not start: ${res.reason ?? 'harness unavailable.'}`,
            timestamp: Date.now(),
          });
          setBusy(false);
          runRef.current = null;
        }
      })
      .catch((e: unknown) => {
        upsert({
          id: `err:${runId}`,
          role: 'system',
          content: `Could not start: ${String(e)}`,
          timestamp: Date.now(),
        });
        setBusy(false);
        runRef.current = null;
      });
  };

  const cancel = (): void => {
    if (runRef.current) void window.triangle.agent.cancel(runRef.current);
  };

  const decideApproval = (approved: boolean, scope: ApprovalScope = 'once'): void => {
    if (!approval) return;
    void window.triangle.agent.approve({ approvalId: approval.approvalId, approved, scope });
    setApproval(null);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  /**
   * Append a grounding context block to the composer. These quick-actions read the
   * live preview directly (renderer-side), so they work for *every* harness — Mock,
   * Claude, and Codex — by injecting the data into the next prompt.
   */
  const appendContext = (block: string): void => {
    setInput((prev) => (prev.trim() ? `${prev.trimEnd()}\n\n${block}` : block));
  };

  const noticeFor = (e: unknown): void => {
    upsert({
      id: `qa-err:${Date.now()}`,
      role: 'system',
      content: String((e as Error).message ?? e),
      timestamp: Date.now(),
    });
  };

  const attachScreenshot = (): void => {
    captureScreenshotPath()
      .then((path) =>
        appendContext(
          `[Triangle context] Current preview screenshot saved at \`${path}\` — read this image file for a visual reference.`,
        ),
      )
      .catch(noticeFor);
  };

  const attachSceneSummary = (): void => {
    try {
      const summary = describeActiveScene();
      appendContext(
        `[Triangle context] Current scene graph:\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\``,
      );
    } catch (e) {
      noticeFor(e);
    }
  };

  const attachPerformance = (): void => {
    try {
      const snap = activePerformanceSnapshot();
      appendContext(
        `[Triangle context] Performance snapshot:\n\`\`\`json\n${JSON.stringify(snap, null, 2)}\n\`\`\``,
      );
    } catch (e) {
      noticeFor(e);
    }
  };

  // Live availability for the currently selected harness (for the notice).
  const selectedLive = availability.find((a) => a.id === harness);
  const selectedUnavailable = selectedLive ? !selectedLive.available : false;

  return (
    <div className="agent">
      <div className="agent__bar">
        <HarnessPicker
          value={harness}
          availability={availability}
          onChange={pickHarness}
          disabled={busy}
        />
        <button
          className={`btn btn--icon${showHistory ? ' btn--active' : ''}`}
          onClick={() => {
            setShowHistory((s) => !s);
            setShowConfig(false);
          }}
          title="Session history"
          aria-pressed={showHistory}
        >
          <History size={14} />
        </button>
        <button
          className={`btn btn--icon${showConfig ? ' btn--active' : ''}`}
          onClick={() => setShowConfig((s) => !s)}
          title="Configure this harness"
          aria-pressed={showConfig}
        >
          <Settings2 size={14} />
        </button>
        <span className="chip" title={`Project: ${projectName}`}>
          <FolderGit2 size={12} />
          {projectName}
        </span>
      </div>

      {showConfig && <HarnessConfig harness={harness} onSaved={refreshHarnesses} />}

      {showHistory ? (
        <SessionHistory projectId={projectId} />
      ) : (
        <>
      {selectedUnavailable && selectedLive?.reason && (
        <div className="agent__notice">
          <TriangleAlert size={14} />
          <span>{selectedLive.reason}</span>
        </div>
      )}

      <div className="agent__messages" ref={scrollRef}>
        {messages.map((msg) => (
          <div key={msg.id} className={`msg msg--${msg.role}`}>
            <span className="msg__role">{msg.role}</span>
            {msg.toolCalls && msg.toolCalls.length > 0 && (
              <div className="msg__tools">
                {msg.toolCalls.map((t) => (
                  <div key={t.id} className={`tool tool--${t.status}`}>
                    <span className="tool__dot" />
                    <span className="tool__name">{t.tool}</span>
                    <span className="tool__args">
                      {t.args.path ? String(t.args.path) : t.args.command ? String(t.args.command) : ''}
                    </span>
                    {t.result && t.status !== 'running' && (
                      <span className="tool__result">{t.result}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
            {msg.content && <div className="msg__bubble">{msg.content}</div>}
          </div>
        ))}
        {busy && !approval && (
          <div className="msg msg--assistant">
            <span className="msg__pending">
              <span className="msg__spinner" />
              working…
            </span>
          </div>
        )}
      </div>

      {approval && (
        <div className="approval">
          <div className="approval__head">
            <ShieldCheck size={14} style={{ color: 'var(--primary)' }} />
            <span className="approval__title">
              {approval.command
                ? 'Approve command'
                : `Approve ${approval.changes.length} change${approval.changes.length === 1 ? '' : 's'}`}
            </span>
            <span className="approval__source">{approval.source}</span>
          </div>
          {approval.reason && <div className="approval__reason">{approval.reason}</div>}
          {approval.command && (
            <pre className="approval__command">
              <Terminal size={12} /> {approval.command}
            </pre>
          )}
          {approval.changes.length > 0 && (
            <div className="approval__diffs">
              {approval.changes.map((change, i) => (
                <DiffView key={`${change.path}:${i}`} change={change} />
              ))}
            </div>
          )}
          <div className="approval__actions">
            <button className="btn" onClick={() => decideApproval(false)}>
              Reject
            </button>
            <button
              className="btn"
              title="Approve this and all further changes for the rest of this run"
              onClick={() => decideApproval(true, 'session')}
            >
              Approve all
            </button>
            <button className="btn btn--primary" onClick={() => decideApproval(true)}>
              Approve
            </button>
          </div>
        </div>
      )}

      <div className="agent__composer">
        <div className="agent__quick-actions">
          <button
            className="btn btn--ghost btn--xs"
            onClick={attachScreenshot}
            title="Capture the preview and attach its path for the agent"
          >
            <Camera size={12} /> Screenshot
          </button>
          <button
            className="btn btn--ghost btn--xs"
            onClick={attachSceneSummary}
            title="Attach a summary of the live scene graph"
          >
            <ListTree size={12} /> Scene
          </button>
          <button
            className="btn btn--ghost btn--xs"
            onClick={attachPerformance}
            title="Attach a performance snapshot"
          >
            <Gauge size={12} /> Perf
          </button>
        </div>
        <div className="composer">
          <textarea
            className="agent__input"
            placeholder="Ask the agent to change the scene…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="composer__row">
            <label className="agent__toggle" title="Skip the per-write approval prompt">
              <input
                type="checkbox"
                checked={autoApprove}
                onChange={(e) => setAutoApprove(e.target.checked)}
              />
              Auto-approve writes
            </label>
            <div className="composer__spacer" />
            {busy ? (
              <button className="btn" onClick={cancel}>
                <Square size={13} /> Stop
              </button>
            ) : (
              <button className="btn btn--primary" onClick={send} disabled={!input.trim()}>
                <Send size={13} /> Send
              </button>
            )}
          </div>
        </div>
      </div>
        </>
      )}
    </div>
  );
}
