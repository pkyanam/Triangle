import { spawn } from 'node:child_process';
import type { ModelInfo } from '@triangle/shared';
import type { TriangleConfig } from '../config.js';
import { ACP_SYSTEM_PROMPT, fetchDevinModels, listAcpSessions, logoutAcpAgent, runAcpSession } from './acp-session.js';
import type { AgentHarness, RunContext } from './harness.js';

/**
 * Devin CLI harness — Triangle drives Devin as an ACP **agent** via `devin acp`,
 * the way Zed / JetBrains / Windsurf launch it (a JSON-RPC ACP server over stdio).
 * This is the *preferred* harness when available. See ADR 0014.
 *
 * It's a thin specialization of the shared {@link runAcpSession} runner (ADR 0013):
 * same `initialize → session/new (advertise Triangle's MCP endpoint) → session/prompt`
 * lifecycle, the same unified approval gate for `fs/*` + permissions, and the same
 * tool-trace surfacing. The Devin-specific bits are:
 *
 *  - **Auth.** Devin's ACP server reads `WINDSURF_API_KEY` if set, else accepts
 *    credentials at runtime via the ACP `authenticate` request. We drive that flow
 *    in the runner (`auth` option) rather than hanging a turn.
 *  - **Command.** `command = devinPath` (default `devin`, resolved on PATH),
 *    `args = ['acp']`.
 *  - **Diagnostics.** `CHISEL_LOG_STDERR=1` keeps Devin's logs off stdout so the
 *    JSON-RPC stream stays clean (stdout logging is auto-suppressed in ACP mode,
 *    belt-and-braces).
 *  - **Model.** `devinModel` is advertised via `session/new` `_meta` (Devin
 *    defaults to adaptive model selection otherwise).
 *  - **Mode & session lifecycle.** Devin modes (`normal`, `accept-edits`, `plan`,
 *    `bypass`) are advertised via `session/new` `_meta` and can be switched later
 *    via `session/set_mode`. Sessions can be listed, resumed, and closed, and the
 *    agent can be logged out via the ACP `logout` method.
 */

export const DEVIN_MODES = ['normal', 'accept-edits', 'plan', 'bypass'] as const;
export type DevinMode = (typeof DEVIN_MODES)[number];

const devinBin = (config: TriangleConfig): string => config.devinPath || 'devin';

/** Whether host-provided credentials are present (Devin's preferred ACP auth). */
const hasWindsurfKey = (): boolean => Boolean(process.env['WINDSURF_API_KEY']);

const AUTH_HINT = 'Run `devin auth login`, or set WINDSURF_API_KEY.';

const devinEnv = (): Record<string, string> => ({ CHISEL_LOG_STDERR: '1' });

/** Spawn `bin args…` and resolve its exit code (or null on spawn failure / timeout). */
function probe(bin: string, args: string[], timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    let done = false;
    const settle = (code: number | null): void => {
      if (done) return;
      done = true;
      resolve(code);
    };
    try {
      const child = spawn(bin, args, { stdio: 'ignore' });
      const timer = setTimeout(() => {
        child.kill();
        settle(null);
      }, timeoutMs);
      child.on('error', () => {
        clearTimeout(timer);
        settle(null);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        settle(code ?? null);
      });
    } catch {
      settle(null);
    }
  });
}

function isDevinMode(value: string): value is DevinMode {
  return DEVIN_MODES.includes(value as DevinMode);
}

function devinModeFromConfig(config: TriangleConfig, instanceConfig?: Record<string, string>): DevinMode | undefined {
  const value = instanceConfig?.mode ?? config.devinMode;
  if (value && isDevinMode(value)) return value;
  return undefined;
}

function devinConfigOptions(config: TriangleConfig, instanceConfig?: Record<string, string>): Record<string, string> | undefined {
  const options: Record<string, string> = {};
  if (config.devinModel) options.model = config.devinModel;
  if (instanceConfig?.model) options.model = instanceConfig.model;
  const mode = devinModeFromConfig(config, instanceConfig);
  if (mode) options.mode = mode;
  return Object.keys(options).length > 0 ? options : undefined;
}

export const devinHarness: AgentHarness = {
  id: 'devin',
  label: 'Devin CLI',

  async availability(config: TriangleConfig) {
    const bin = devinBin(config);
    const version = await probe(bin, ['--version'], 4000);
    if (version !== 0) {
      return { available: false, reason: `Devin CLI ('${bin}') not found on PATH.` };
    }
    // Binary is present → selectable. It's only the *default* when authenticated:
    // we surface an auth hint (shown as the picker note) until then, but keep it
    // available so the operator can still trigger the runtime `authenticate` flow.
    if (hasWindsurfKey()) return { available: true };
    const authed = (await probe(bin, ['auth', 'status'], 4000)) === 0;
    return authed
      ? { available: true }
      : { available: true, reason: `Authenticate Devin to make it the default: ${AUTH_HINT}` };
  },

  async models(config: TriangleConfig): Promise<ModelInfo[]> {
    return fetchDevinModels(devinBin(config), ['acp'], devinEnv(), 10_000);
  },

  run(ctx: RunContext): Promise<void> {
    const configOptions = devinConfigOptions(ctx.config, ctx.instanceConfig);
    return runAcpSession(ctx, {
      command: devinBin(ctx.config),
      args: ['acp'],
      label: 'Devin',
      // Keep Devin's diagnostics off stdout so the JSON-RPC stream stays clean.
      env: devinEnv(),
      // Devin runs commands in its own execution environment and surfaces output
      // via tool-call updates, so the client need not provide an ACP terminal.
      capabilities: { fs: { readTextFile: true, writeTextFile: true }, image: true },
      ...(ctx.config.devinModel ? { model: ctx.config.devinModel } : {}),
      ...(configOptions?.mode ? { mode: configOptions.mode } : {}),
      ...(configOptions && Object.keys(configOptions).length > 0 ? { configOptions } : {}),
      ...(ctx.resumeSessionId ? { resumeSessionId: ctx.resumeSessionId } : {}),
      systemPrompt: ctx.systemPrompt ?? ACP_SYSTEM_PROMPT,
      mcpServers: [
        {
          name: 'triangle',
          command: process.execPath,
          args: [ctx.toolBridge.serverScriptPath],
          env: [
            { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
            { name: 'TRIANGLE_BRIDGE_PORT', value: String(ctx.toolBridge.port) },
            { name: 'TRIANGLE_BRIDGE_TOKEN', value: ctx.toolBridge.token },
          ],
        },
      ],
      auth: {
        // Prefer the no-up-front-auth path: try session/new first and only run the
        // ACP authenticate flow if the agent rejects the session as unauthenticated.
        // This avoids re-prompting the user on every Devin prompt when they have
        // already run `devin auth login` or set WINDSURF_API_KEY.
        hasCredentials: true,
        prefer: ['windsurf', 'api', 'key', 'token'],
        hint: AUTH_HINT,
      },
    });
  },
};

/** List Devin's ACP sessions. Returns an empty list on error. */
export function listDevinSessions(config: TriangleConfig): Promise<
  Array<{ sessionId: string; name?: string; createdAt?: string }>
> {
  return listAcpSessions(devinBin(config), ['acp'], devinEnv(), 10_000);
}

/** Log out of the Devin ACP agent. */
export function logoutDevin(config: TriangleConfig): Promise<{ ok: boolean; error?: string }> {
  return logoutAcpAgent(devinBin(config), ['acp'], devinEnv(), 10_000);
}
