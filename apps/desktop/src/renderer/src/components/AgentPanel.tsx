import { useEffect, useRef, useState } from 'react';
import { HARNESSES, type ChatMessage, type HarnessId } from '@triangle/shared';

let idCounter = 0;
const nextId = (): string => `m${++idCounter}`;

const GREETING: ChatMessage = {
  id: nextId(),
  role: 'system',
  content:
    'Mock agent active (Stage 1). Real harnesses — Claude Agent SDK, Codex CLI, ACP/MCP — ' +
    'wire in here in Stage 2+. Try: "make the knot blue" or "add more particles".',
  timestamp: Date.now(),
};

/** Canned, deterministic responses so the loop feels real without a backend. */
function mockReply(prompt: string): string {
  const p = prompt.toLowerCase();
  if (p.includes('shader') || p.includes('glsl'))
    return 'In Stage 2 I would open src/main.js, edit the fragment shader uniforms, and you\u2019d see the preview hot-reload. For now this is a canned response — shader validation tooling lands in Stage 3.';
  if (p.includes('color') || p.includes('blue') || p.includes('red'))
    return 'Got it — I\u2019d change the `uColorB` uniform in the shader material and save the file. The center preview would hot-reload instantly once file-writing tools are enabled (Stage 2).';
  if (p.includes('particle'))
    return 'I\u2019d bump the instanced particle `count` in setup() and rebuild the InstancedMesh. Live scene-manipulation tools (no full reload needed) arrive in Stage 4.';
  if (p.includes('screenshot') || p.includes('see'))
    return 'The screenshot + structured scene-description pipeline (multimodal grounding) is a Stage 3 deliverable. The schema is already declared in @triangle/shared.';
  return 'Acknowledged. This is the Stage 1 mock agent, so I can\u2019t edit files yet — but the chat, harness selector, and message loop are fully wired and ready for a real harness.';
}

interface AgentPanelProps {
  projectName: string;
}

export function AgentPanel({ projectName }: AgentPanelProps): React.JSX.Element {
  const [harness, setHarness] = useState<HarnessId>('mock');
  const [messages, setMessages] = useState<ChatMessage[]>([GREETING]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const send = (): void => {
    const text = input.trim();
    if (!text || busy) return;
    const userMsg: ChatMessage = { id: nextId(), role: 'user', content: text, timestamp: Date.now() };
    const pending: ChatMessage = {
      id: nextId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      pending: true,
    };
    setMessages((m) => [...m, userMsg, pending]);
    setInput('');
    setBusy(true);

    // Simulate the agent "thinking" then streaming a reply.
    window.setTimeout(() => {
      const reply = mockReply(text);
      setMessages((m) =>
        m.map((msg) => (msg.id === pending.id ? { ...msg, content: reply, pending: false } : msg)),
      );
      setBusy(false);
    }, 550);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="agent">
      <div className="agent__harness">
        <select
          className="agent__select"
          value={harness}
          onChange={(e) => setHarness(e.target.value as HarnessId)}
        >
          {HARNESSES.map((h) => (
            <option key={h.id} value={h.id} disabled={!h.available}>
              {h.label}
              {h.available ? '' : ' — soon'}
            </option>
          ))}
        </select>
        <span className="chip">{projectName}</span>
      </div>

      <div className="agent__messages" ref={scrollRef}>
        {messages.map((msg) => (
          <div key={msg.id} className={`msg msg--${msg.role}`}>
            <span className="msg__role">{msg.role}</span>
            <div className="msg__bubble">
              {msg.pending ? <span className="msg__pending">thinking…</span> : msg.content}
            </div>
          </div>
        ))}
      </div>

      <div className="agent__composer">
        <textarea
          className="agent__input"
          placeholder="Ask the agent to change the scene…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="agent__composer-row">
          <span className="agent__hint">Enter to send · Shift+Enter for newline</span>
          <button className="btn btn--primary" onClick={send} disabled={busy || !input.trim()}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
