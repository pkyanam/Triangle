import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Camera,
  FolderGit2,
  Gauge,
  History,
  ImagePlus,
  List,
  ListTree,
  Send,
  Settings2,
  Square,
  Terminal,
  TriangleAlert,
  Wrench,
  X,
} from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import {
  type AgentEvent,
  type AgentSettings,
  type ApprovalRequest,
  type ApprovalScope,
  type ChatMessage,
  type ChatRole,
  type HarnessAvailability,
  type ImageAttachment,
  type ToolCallKind,
  type ToolCallTrace,
} from '@triangle/shared';
import { ProviderModelPicker } from './ProviderModelPicker.js';
import { ProviderInstancesSettings } from './ProviderInstancesSettings.js';
import { SessionHistory } from './SessionHistory.js';
import { DiffView } from './DiffView.js';
import { Card } from './ui/card.js';
import { Button } from './ui/button.js';
import { cn } from '../lib/utils.js';
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
    'Triangle agent ready. Pick a provider instance and model from the picker. Devin and Codex are ' +
    'configured by default; Claude and ACP can be added in Settings. The agent edits project files ' +
    '(gated by approval unless auto-approve is on) and the preview hot-reloads on save. Every run is ' +
    'saved to History and survives restarts.',
  timestamp: Date.now(),
};

const MAX_IMAGE_ATTACHMENTS = 8;
const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;

const TOOL_KIND_LABELS: Record<ToolCallKind, string> = {
  read: 'Read',
  edit: 'Edit',
  delete: 'Delete',
  move: 'Move',
  search: 'Search',
  execute: 'Run',
  think: 'Think',
  fetch: 'Fetch',
  other: 'Tool',
};

interface AgentPanelProps {
  projectName: string;
  /** Active project id — used to scope session history and reset the chat on switch. */
  projectId: string;
}

export function AgentPanel({ projectName, projectId }: AgentPanelProps): React.JSX.Element {
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [availability, setAvailability] = useState<HarnessAvailability[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([GREETING]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [autoApprove, setAutoApprove] = useState(false);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showToolRunner, setShowToolRunner] = useState(false);
  const [toolName, setToolName] = useState('hf_generate_3d_asset');
  const [toolArgs, setToolArgs] = useState('{ "prompt": "a low-poly tree", "provider": "hunyuan3d" }');
  const [toolBusy, setToolBusy] = useState(false);
  const [runStartTime, setRunStartTime] = useState<number | null>(null);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [devinSessions, setDevinSessions] = useState<Array<{ sessionId: string; name?: string; createdAt?: string }> | null>(null);
  const [resumeSessionId, setResumeSessionId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const runRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const reduceMotion = useReducedMotion();

  const selectedInstance = useMemo(
    () => settings?.providerInstances.find((i) => i.id === settings?.selectedInstanceId) ?? settings?.providerInstances[0],
    [settings],
  );
  const selectedHarness = selectedInstance?.kind ?? 'mock';
  const selectedModel = selectedInstance?.model ?? 'default';
  const selectedAvail = availability.find((a) => a.id === selectedHarness);
  const selectedUnavailable = selectedAvail ? !selectedAvail.available : false;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, approval]);

  const refreshHarnesses = useCallback(() => {
    void window.triangle.agent.harnesses().then(setAvailability);
  }, []);

  const persistSettings = useCallback((next: AgentSettings) => {
    setSettings(next);
    void window.triangle.config.set(next).then(setSettings);
  }, []);

  const setAutoApprovePersisted = useCallback(
    (value: boolean) => {
      setAutoApprove(value);
      if (settings) {
        persistSettings({ ...settings, autoApproveWrites: value });
      }
    },
    [settings, persistSettings],
  );

  // Load runtime harness availability + the persisted settings.
  useEffect(() => {
    refreshHarnesses();
    void window.triangle.config.get().then((s) => {
      setSettings(s);
      if (typeof s.autoApproveWrites === 'boolean') setAutoApprove(s.autoApproveWrites);
    });
  }, [refreshHarnesses]);

  // Switching projects resets the live chat and dismisses any pending approval.
  useEffect(() => {
    setMessages([GREETING]);
    setApproval(null);
    setShowHistory(false);
    runRef.current = null;
    setBusy(false);
    setRunStartTime(null);
    setAttachments([]);
    setDevinSessions(null);
    setResumeSessionId(null);
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

  /** Insert or update a tool trace as its own chronologically ordered message. */
  const upsertTrace = useCallback((runId: string, trace: ToolCallTrace) => {
    const id = `t:${runId}:${trace.id}`;
    upsert({
      id,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [trace],
    });
  }, [upsert]);

  /** Read a File as a base64 data URL. */
  const readFileAsDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
      reader.readAsDataURL(file);
    });

  const imageAttachmentDedupKey = (image: ImageAttachment): string => `${image.mimeType}\0${image.sizeBytes}\0${image.name}`;

  const addImages = useCallback(async (files: FileList | File[] | null) => {
    if (!files || files.length === 0) return;
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (imageFiles.length === 0) {
      noticeFor(new Error('Only image files can be attached.'));
      return;
    }
    const accepted: ImageAttachment[] = [];
    for (const file of imageFiles) {
      if (file.size > MAX_IMAGE_SIZE_BYTES) {
        noticeFor(new Error(`'${file.name}' exceeds the 10 MB image attachment limit.`));
        continue;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        accepted.push({
          id: nextId(),
          name: file.name || 'image',
          mimeType: file.type,
          sizeBytes: file.size,
          dataUrl,
        });
      } catch (e) {
        noticeFor(e);
      }
    }
    if (accepted.length === 0) return;
    setAttachments((prev) => {
      const existingKeys = new Set(prev.map(imageAttachmentDedupKey));
      const deduped = accepted.filter((a) => !existingKeys.has(imageAttachmentDedupKey(a)));
      const combined = [...prev, ...deduped];
      if (combined.length > MAX_IMAGE_ATTACHMENTS) {
        noticeFor(new Error(`You can attach up to ${MAX_IMAGE_ATTACHMENTS} images.`));
        return combined.slice(0, MAX_IMAGE_ATTACHMENTS);
      }
      return combined;
    });
  }, []);

  const removeImage = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const onPaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    void addImages(e.clipboardData.files);
  }, [addImages]);

  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setIsDragging(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    const nextTarget = e.relatedTarget;
    if (nextTarget instanceof Node && e.currentTarget.contains(nextTarget)) return;
    setIsDragging(false);
  }, []);

  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    setIsDragging(false);
    void addImages(e.dataTransfer.files);
  }, [addImages]);

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
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
            id: `log:${event.runId}:${Date.now()}`,
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
            setRunStartTime(null);
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

  const handleInstanceChange = useCallback(
    (instanceId: string, model: string) => {
      if (!settings) return;
      const nextInstances = settings.providerInstances.map((i) =>
        i.id === instanceId ? { ...i, model } : i,
      );
      persistSettings({ ...settings, selectedInstanceId: instanceId, providerInstances: nextInstances });
    },
    [settings, persistSettings],
  );

  const handleToggleFavorite = useCallback(
    (instanceId: string, model: string) => {
      if (!settings) return;
      const favs = settings.favorites ? [...settings.favorites] : [];
      const idx = favs.findIndex((f) => f.instanceId === instanceId && f.model === model);
      if (idx >= 0) favs.splice(idx, 1);
      else favs.push({ instanceId, model });
      persistSettings({ ...settings, favorites: favs });
    },
    [settings, persistSettings],
  );

  const send = (): void => {
    const text = input.trim();
    if (!text || busy || !selectedInstance) return;
    const runId = newRunId();
    runRef.current = runId;
    const currentAttachments = attachments;
    const currentResumeSessionId = resumeSessionId ?? undefined;
    setMessages((m) => [
      ...m,
      { id: nextId(), role: 'user', content: text, timestamp: Date.now(), attachments: currentAttachments },
    ]);
    setInput('');
    setAttachments([]);
    setResumeSessionId(null);
    setBusy(true);
    setRunStartTime(Date.now());

    void window.triangle.agent
      .start({
        runId,
        harness: selectedHarness,
        prompt: text,
        autoApproveWrites: autoApprove,
        instanceId: selectedInstance.id,
        model: selectedModel,
        attachments: currentAttachments,
        resumeSessionId: currentResumeSessionId,
      })
      .then((res) => {
        if (!res.accepted) {
          upsert({
            id: `err:${runId}`,
            role: 'system',
            content: `Could not start: ${res.reason ?? 'harness unavailable.'}`,
            timestamp: Date.now(),
          });
          setBusy(false);
          setRunStartTime(null);
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
        setRunStartTime(null);
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

  const runTool = (): void => {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(toolArgs);
    } catch (e) {
      noticeFor(e);
      return;
    }
    setToolBusy(true);
    void window.triangle.tool
      .run({ tool: toolName, args })
      .then((res) => {
        if (res.ok) {
          upsert({
            id: `tool-run:${Date.now()}`,
            role: 'system',
            content: `\`\`\`json\n${res.result}\n\`\`\``,
            timestamp: Date.now(),
          });
        } else {
          noticeFor(new Error(res.error ?? 'Tool run failed.'));
        }
      })
      .catch(noticeFor)
      .finally(() => setToolBusy(false));
  };

  const grouped = useMemo(() => groupMessages(messages), [messages]);

  const loadDevinSessions = useCallback(() => {
    void window.triangle.devin
      .sessions()
      .then((sessions) => {
        setDevinSessions(sessions);
        if (sessions.length === 0) {
          noticeFor(new Error('No resumable Devin sessions found.'));
        }
      })
      .catch((e: unknown) => noticeFor(new Error(`Could not list Devin sessions: ${String(e)}`)));
  }, []);

  const selectDevinSession = useCallback((sessionId: string) => {
    setResumeSessionId(sessionId);
    setDevinSessions(null);
    upsert({
      id: `resume-${sessionId}`,
      role: 'system',
      content: `Resuming Devin session ${sessionId}. Send a message to continue.`,
      timestamp: Date.now(),
    });
  }, [upsert]);

  return (
    <div className="agent agent--engine">
      <div className="agent__bar">
        {settings ? (
          <ProviderModelPicker
            instances={settings.providerInstances}
            selectedInstanceId={settings.selectedInstanceId}
            selectedModel={selectedModel}
            availability={availability}
            favorites={settings.favorites ?? []}
            onChange={handleInstanceChange}
            onToggleFavorite={handleToggleFavorite}
            onOpenSettings={() => {
              setShowConfig(true);
              setShowHistory(false);
            }}
            disabled={busy}
          />
        ) : (
          <span className="chip">Loading providers…</span>
        )}
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
          title="Configure providers"
          aria-pressed={showConfig}
        >
          <Settings2 size={14} />
        </button>
        {selectedHarness === 'devin' && (
          <button
            className={`btn btn--icon${devinSessions ? ' btn--active' : ''}`}
            onClick={() => {
              if (devinSessions) setDevinSessions(null);
              else loadDevinSessions();
            }}
            title="Devin ACP sessions"
            aria-pressed={devinSessions !== null}
          >
            <List size={14} />
          </button>
        )}
        <span className="chip" title={`Project: ${projectName}`}>
          <FolderGit2 size={12} />
          {projectName}
        </span>
      </div>

      {showConfig && <ProviderInstancesSettings availability={availability} onSaved={refreshHarnesses} />}

      {devinSessions && devinSessions.length > 0 && (
        <div className="agent__notice agent__notice--sessions">
          <List size={14} />
          <div className="agent__session-list">
            <span className="agent__session-list-title">Devin sessions</span>
            {devinSessions.map((s) => (
              <button
                key={s.sessionId}
                className="agent__session-item"
                onClick={() => selectDevinSession(s.sessionId)}
                title={`Resume ${s.sessionId}`}
              >
                {s.name ?? s.sessionId}
              </button>
            ))}
          </div>
        </div>
      )}

      {showHistory ? (
        <SessionHistory projectId={projectId} />
      ) : (
        <>
          {selectedUnavailable && selectedAvail?.reason && (
            <div className="agent__notice">
              <TriangleAlert size={14} />
              <span>{selectedAvail.reason}</span>
            </div>
          )}

          <div className="agent__messages" ref={scrollRef}>
            {grouped.map((group, groupIdx) => (
              <motion.div
                key={`group-${groupIdx}-${group.items[0]?.id ?? ''}`}
                className={`msg-group msg-group--${group.role}`}
                initial={reduceMotion ? undefined : { opacity: 0, y: 8 }}
                animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
              >
                {group.items.map((msg) => (
                  <div key={msg.id} className={`msg msg--${msg.role}`}>
                    <span className="msg__role">{msg.role}</span>
                    {msg.toolCalls && msg.toolCalls.length > 0 && (
                      <div className="msg__tools">
                        {msg.toolCalls.map((t) => (
                          <div key={t.id} className={`tool tool--${t.status}`}>
                            <span className="tool__dot" />
                            <span className="tool__kind">{t.kind ? TOOL_KIND_LABELS[t.kind] : 'Tool'}</span>
                            <span className="tool__name">{t.tool}</span>
                            <span className="tool__args">
                              {t.args.path ? String(t.args.path) : t.args.command ? String(t.args.command) : ''}
                            </span>
                            {t.result && t.status !== 'running' && <span className="tool__result">{t.result}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                    {msg.content && (
                      <Card className={cn('msg__bubble', msg.role === 'system' && 'msg__bubble--system')}>
                        {msg.content}
                      </Card>
                    )}
                    {msg.attachments && msg.attachments.length > 0 && (
                      <div className="msg__attachments">
                        {msg.attachments.map((a) => (
                          <img
                            key={a.id}
                            src={a.dataUrl}
                            alt={a.name}
                            className="msg__attachment-thumb"
                            title={`${a.name} (${(a.sizeBytes / 1024).toFixed(1)} KB)`}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </motion.div>
            ))}
            {busy && !approval && (
              <div className="msg msg--assistant">
                <StreamingIndicator startTime={runStartTime} />
              </div>
            )}
          </div>

          {approval && (
            <motion.div
              initial={reduceMotion ? undefined : { opacity: 0, scale: 0.98 }}
              animate={reduceMotion ? undefined : { opacity: 1, scale: 1 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              <Card className="approval">
                <div className="approval__head">
                  <Terminal size={14} style={{ color: 'var(--signal-fg)' }} />
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
                  <Button variant="ghost" size="xs" onClick={() => decideApproval(false)}>
                    Reject
                  </Button>
                  <Button
                    variant="primary"
                    size="xs"
                    title="Approve this and all further changes for the rest of this run"
                    onClick={() => decideApproval(true, 'session')}
                  >
                    Approve all
                  </Button>
                  <Button variant="primary" size="xs" onClick={() => decideApproval(true)}>
                    Approve
                  </Button>
                </div>
              </Card>
            </motion.div>
          )}

          <div
            className={cn('agent__composer', isDragging && 'agent__composer--drag-over')}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          >
            <div className="agent__quick-actions">
              <button
                className="toolbar-btn"
                onClick={attachScreenshot}
                title="Capture the preview and attach its path for the agent"
              >
                <Camera size={14} />
              </button>
              <button
                className="toolbar-btn"
                onClick={attachSceneSummary}
                title="Attach a summary of the live scene graph"
              >
                <ListTree size={14} />
              </button>
              <button
                className="toolbar-btn"
                onClick={attachPerformance}
                title="Attach a performance snapshot"
              >
                <Gauge size={14} />
              </button>
              <button
                className="toolbar-btn"
                onClick={openFilePicker}
                title="Attach images (drag & drop or paste also works)"
              >
                <ImagePlus size={14} />
              </button>
              <button
                className={`toolbar-btn${showToolRunner ? ' toolbar-btn--active' : ''}`}
                onClick={() => setShowToolRunner((s) => !s)}
                title="Run an integration tool manually"
              >
                <Wrench size={14} />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => {
                  void addImages(e.target.files);
                  if (e.target) e.target.value = '';
                }}
              />
            </div>
            {showToolRunner && (
              <div className="agent__tool-runner">
                <div className="agent__tool-runner-row">
                  <select
                    className="agent__tool-runner-select"
                    value={toolName}
                    onChange={(e) => setToolName(e.target.value)}
                  >
                    <option value="hf_generate_3d_asset">HF generate 3D asset</option>
                    <option value="download_3d_asset">Download 3D asset</option>
                    <option value="triangle_import_3d_asset">Import 3D asset</option>
                    <option value="triangle_robotics_snippet">Robotics snippet</option>
                  </select>
                  <Button variant="primary" size="xs" onClick={runTool} disabled={toolBusy}>
                    {toolBusy ? <span className="spin" /> : <Box size={12} />} Run
                  </Button>
                </div>
                <textarea
                  className="agent__tool-runner-args"
                  rows={3}
                  value={toolArgs}
                  onChange={(e) => setToolArgs(e.target.value)}
                  spellCheck={false}
                />
              </div>
            )}
            <div className="composer">
              {attachments.length > 0 && (
                <div className="agent__attachment-strip">
                  {attachments.map((a) => (
                    <div key={a.id} className="agent__attachment-chip">
                      <img src={a.dataUrl} alt={a.name} className="agent__attachment-thumb" />
                      <span className="agent__attachment-name">{a.name}</span>
                      <button
                        className="agent__attachment-remove"
                        onClick={() => removeImage(a.id)}
                        title="Remove image"
                        aria-label={`Remove ${a.name}`}
                      >
                        <X size={10} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {isDragging && (
                <div className="agent__drag-overlay">
                  <ImagePlus size={24} />
                  <span>Drop images here</span>
                </div>
              )}
              <textarea
                className="agent__input"
                placeholder="Ask the agent to change the scene…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
              />
              <div className="composer__row">
                <label className="agent__toggle" title="Skip the per-write approval prompt">
                  <input
                    type="checkbox"
                    checked={autoApprove}
                    onChange={(e) => setAutoApprovePersisted(e.target.checked)}
                  />
                  Auto-approve writes
                </label>
                <div className="composer__spacer" />
                {busy ? (
                  <Button variant="ghost" onClick={cancel}>
                    <Square size={13} /> Stop
                  </Button>
                ) : (
                  <Button variant="primary" onClick={send} disabled={!input.trim() || !selectedInstance}>
                    <Send size={13} /> Send
                  </Button>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Group consecutive messages from the same role so the UI can reduce spacing. */
function groupMessages(msgs: ChatMessage[]): { role: ChatRole; items: ChatMessage[] }[] {
  const groups: { role: ChatRole; items: ChatMessage[] }[] = [];
  for (const msg of msgs) {
    const last = groups[groups.length - 1];
    if (last && last.role === msg.role) {
      last.items.push(msg);
    } else {
      groups.push({ role: msg.role, items: [msg] });
    }
  }
  return groups;
}

function StreamingIndicator({ startTime }: { startTime: number | null }): React.JSX.Element {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (startTime == null) return;
    const update = () => setElapsed(Math.floor((Date.now() - startTime) / 1000));
    update();
    const id = window.setInterval(update, 1000);
    return () => window.clearInterval(id);
  }, [startTime]);

  return (
    <span className="msg__pending">
      <span className="msg__dots">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="msg__dot"
            animate={{ opacity: [0.35, 1, 0.35] }}
            transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2, ease: 'easeInOut' }}
          />
        ))}
      </span>
      working{elapsed > 0 ? ` · ${elapsed}s` : ''}
    </span>
  );
}
