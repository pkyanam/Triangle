import type { ModelInfo } from '@triangle/shared';
import { harnessTraceId, type AgentHarness, type RunContext } from './harness.js';

/**
 * Deterministic mock harness — the Stage 1 canned agent, now routed through the same
 * orchestration path as the real harnesses. Useful as an always-available fallback and
 * for exercising the streaming/approval UI without API keys.
 */
export const mockHarness: AgentHarness = {
  id: 'mock',
  label: 'Mock Agent',

  async availability() {
    return { available: true };
  },

  async models(): Promise<ModelInfo[]> {
    return [{ id: 'mock', name: 'Mock', description: 'Canned responses' }];
  },

  async run(ctx: RunContext): Promise<void> {
    const { prompt, emit, signal } = ctx;
    const p = prompt.toLowerCase();

    const wait = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
      });

    await wait(300);
    if (signal.aborted) return;

    let reply: string;
    if (p.includes('color') || p.includes('blue') || p.includes('red')) {
      // Show a tool trace so the UI's trace rendering is exercised.
      emit({
        type: 'tool',
        trace: {
          id: harnessTraceId(),
          tool: 'triangle_read_file',
          args: { path: 'src/main.js' },
          status: 'ok',
          result: 'Read src/main.js (mock).',
        },
      });
      reply =
        'Mock: I would change the shader color uniform in src/main.js and save it — the ' +
        'preview hot-reloads on save. Pick the Claude or Codex harness for real edits.';
    } else if (p.includes('particle')) {
      reply = 'Mock: I would bump the instanced particle count in setup() and rebuild the mesh.';
    } else {
      reply =
        'Mock agent: chat, streaming, tool traces and the approval gate are all wired. ' +
        'Select Claude Agent SDK or Codex CLI (with credentials) to perform real edits.';
    }

    await wait(250);
    if (signal.aborted) return;
    emit({ type: 'assistant', messageId: harnessTraceId(), text: reply });
  },
};
