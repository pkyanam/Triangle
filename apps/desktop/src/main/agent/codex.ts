import { spawn } from 'node:child_process';
import readline from 'node:readline';
import type { TriangleConfig } from '../config.js';
import { harnessTraceId, type AgentHarness, type RunContext } from './harness.js';

/**
 * Codex CLI harness. Delegates a task to OpenAI's `codex` binary in non-interactive
 * mode (`codex exec --json`), parsing its JSONL event stream into Triangle agent events.
 *
 * Unlike the Claude harness (whose writes route through ProjectManager + the approval
 * gate), Codex edits files directly on disk within a `workspace-write` sandbox scoped to
 * the project root; the file watcher then reflects those edits into the editor/preview.
 * See ADR 0005 for that boundary.
 */

const codexBin = (config: TriangleConfig): string => config.codexPath || 'codex';

/** Resolve a string field from any of several candidate keys. */
function pick(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

export const codexHarness: AgentHarness = {
  id: 'codex',
  label: 'Codex CLI',

  availability(config: TriangleConfig) {
    return new Promise((resolve) => {
      const bin = codexBin(config);
      let settled = false;
      const done = (available: boolean, reason?: string): void => {
        if (settled) return;
        settled = true;
        resolve({ available, reason });
      };
      try {
        const child = spawn(bin, ['--version'], { stdio: 'ignore' });
        const timer = setTimeout(() => {
          child.kill();
          done(false, 'Codex CLI did not respond.');
        }, 4000);
        child.on('error', () => {
          clearTimeout(timer);
          done(false, `Codex CLI ('${bin}') not found on PATH.`);
        });
        child.on('exit', (code) => {
          clearTimeout(timer);
          if (code === 0) done(true);
          else done(false, `Codex CLI exited with code ${code ?? 'null'}.`);
        });
      } catch {
        done(false, `Codex CLI ('${bin}') not found on PATH.`);
      }
    });
  },

  run(ctx: RunContext): Promise<void> {
    const { prompt, projectRoot, config, emit, signal } = ctx;
    const bin = codexBin(config);

    const args = ['exec', '--json', '--sandbox', 'workspace-write', '-C', projectRoot];
    if (config.codexModel) args.push('--model', config.codexModel);
    args.push(prompt);

    return new Promise<void>((resolve, reject) => {
      const child = spawn(bin, args, {
        cwd: projectRoot,
        env: { ...process.env },
      });

      let failure: string | null = null;
      const stderrTail: string[] = [];

      const onAbort = (): void => {
        child.kill();
      };
      if (signal.aborted) child.kill();
      else signal.addEventListener('abort', onAbort, { once: true });

      child.on('error', (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(new Error(`Failed to launch Codex CLI: ${err.message}`));
      });

      const out = readline.createInterface({ input: child.stdout });
      out.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          return; // non-JSON progress line
        }
        handleEvent(ev, emit, (msg) => (failure = msg));
      });

      const err = readline.createInterface({ input: child.stderr });
      err.on('line', (line) => {
        if (line.trim()) {
          stderrTail.push(line);
          if (stderrTail.length > 20) stderrTail.shift();
        }
      });

      child.on('close', (code) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) return resolve();
        if (failure) return reject(new Error(failure));
        if (code === 0) return resolve();
        const detail = stderrTail.join('\n').trim();
        reject(new Error(`Codex CLI exited with code ${code ?? 'null'}${detail ? `:\n${detail}` : ''}`));
      });
    });
  },
};

/** Map a single Codex JSONL event onto Triangle harness events. */
function handleEvent(
  ev: Record<string, unknown>,
  emit: RunContext['emit'],
  setFailure: (msg: string) => void,
): void {
  const type = typeof ev['type'] === 'string' ? (ev['type'] as string) : '';

  if (type === 'error' || type === 'turn.failed') {
    const errObj = (ev['error'] as Record<string, unknown> | undefined) ?? ev;
    setFailure(pick(errObj, 'message', 'reason') ?? 'Codex reported an error.');
    return;
  }

  if (type === 'item.completed' || type === 'item.updated') {
    const item = (ev['item'] as Record<string, unknown> | undefined) ?? {};
    const itemType = typeof item['type'] === 'string' ? (item['type'] as string) : '';
    const id = pick(item, 'id') ?? harnessTraceId();

    if (itemType === 'assistant_message' || itemType === 'agent_message') {
      const text = pick(item, 'text', 'message');
      if (text) emit({ type: 'assistant', messageId: id, text });
      return;
    }
    if (itemType === 'command_execution') {
      const command = pick(item, 'command') ?? '(command)';
      const status = pick(item, 'status') === 'failed' ? 'error' : 'ok';
      emit({
        type: 'tool',
        trace: {
          id,
          tool: 'command',
          args: { command },
          status,
          result: pick(item, 'aggregated_output', 'output'),
        },
      });
      return;
    }
    if (itemType === 'file_change' || itemType === 'patch' || itemType === 'file_update') {
      emit({
        type: 'tool',
        trace: {
          id,
          tool: 'file_change',
          args: { path: pick(item, 'path') ?? '(files)' },
          status: 'ok',
          result: pick(item, 'summary', 'status'),
        },
      });
      return;
    }
    if (itemType === 'reasoning') {
      const text = pick(item, 'text');
      if (text) emit({ type: 'log', level: 'info', text });
    }
  }
}
