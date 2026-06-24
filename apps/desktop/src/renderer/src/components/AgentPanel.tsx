import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderGit2, Send, ShieldCheck, Square, TriangleAlert } from 'lucide-react';
import {
  type AgentEvent,
  type ApprovalRequest,
  type ChatMessage,
  type HarnessAvailability,
  type HarnessId,
  type ToolCallTrace,
} from '@triangle/shared';
import { HarnessPicker } from './HarnessPicker.js';

let idCounter = 0;
const nextId = (): string => `m${++idCounter}`;
const newRunId = (): string => `run_${Date.now()}_${++idCounter}`;

const GREETING: ChatMessage = {
  id: nextId(),
  role: 'system',
  content:
    'Triangle agent ready. Pick a harness: the Mock agent works with no setup; Claude Agent ' +
    'SDK needs ANTHROPIC_API_KEY; Codex CLI needs the `codex` binary. The agent edits project ' +
    'files (gated by approval unless auto-approve is on) and the preview hot-reloads on save.',
  timestamp: Date.now(),
};

interface AgentPanelProps {
  projectName: string;
}

export function AgentPanel({ projectName }: AgentPanelProps): React.JSX.Element {
  const [harness, setHarness] = useState<HarnessId>('mock');
  const [availability, setAvailability] = useState<HarnessAvailability[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([GREETING]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [autoApprove, setAutoApprove] = useState(false);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const runRef = useRef<string | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, approval]);

  // Load runtime harness availability.
  useEffect(() => {
    let active = true;
    void window.triangle.agent.harnesses().then((list) => {
      if (active) setAvailability(list);
    });
    return () => {
      active = false;
    };
  }, []);

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

  const decideApproval = (approved: boolean): void => {
    if (!approval) return;
    void window.triangle.agent.approve({ approvalId: approval.approvalId, approved });
    setApproval(null);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
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
          onChange={setHarness}
          disabled={busy}
        />
        <span className="chip" title={`Project: ${projectName}`}>
          <FolderGit2 size={12} />
          {projectName}
        </span>
      </div>

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
              Approve write {approval.exists ? '(overwrite)' : '(new file)'}
            </span>
          </div>
          <div className="approval__path">{approval.path}</div>
          <pre className="approval__preview">{approval.content}</pre>
          <div className="approval__actions">
            <button className="btn" onClick={() => decideApproval(false)}>
              Reject
            </button>
            <button className="btn btn--primary" onClick={() => decideApproval(true)}>
              Approve
            </button>
          </div>
        </div>
      )}

      <div className="agent__composer">
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
    </div>
  );
}
