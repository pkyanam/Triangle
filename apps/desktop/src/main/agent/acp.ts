import type { ModelInfo } from '@triangle/shared';
import type { TriangleConfig } from '../config.js';
import { runAcpSession } from './acp-session.js';
import type { AgentHarness, RunContext } from './harness.js';

/**
 * Generic ACP (Agent Client Protocol) harness — Triangle as an ACP **client**
 * driving an arbitrary external ACP **agent** subprocess (e.g. `gemini` with its
 * experimental ACP flag). See ADR 0013.
 *
 * The protocol mechanics live in the shared {@link runAcpSession} runner (also
 * used by the first-class Devin harness, ADR 0014). This harness is just the
 * config-driven entry point: it resolves `acpAgentCommand` / `acpAgentArgs` and
 * hands off. It declares no auth handling (most generic agents authenticate out of
 * band); Devin's `authenticate` flow lives in its own harness.
 */

const acpCommand = (config: TriangleConfig): string | undefined => config.acpAgentCommand;

export const acpHarness: AgentHarness = {
  id: 'acp',
  label: 'ACP Agent',

  async availability(config: TriangleConfig) {
    const command = acpCommand(config);
    if (!command) {
      return {
        available: false,
        reason: 'Set acpAgentCommand in .triangle/config.json to connect an ACP agent.',
      };
    }
    return { available: true };
  },

  async models(): Promise<ModelInfo[]> {
    return [{ id: 'auto', name: 'Auto', description: 'Adaptive model selection' }];
  },

  run(ctx: RunContext): Promise<void> {
    const command = acpCommand(ctx.config);
    if (!command) return Promise.reject(new Error('No ACP agent command configured.'));
    return runAcpSession(ctx, {
      command,
      args: ctx.config.acpAgentArgs ?? [],
      label: ctx.config.acpAgentLabel || 'ACP agent',
      capabilities: { fs: { readTextFile: true, writeTextFile: true }, image: true },
      ...(ctx.resumeSessionId ? { resumeSessionId: ctx.resumeSessionId } : {}),
      mcpServers: [
        {
          name: 'triangle',
          command: process.execPath,
          args: [ctx.toolBridge.serverScriptPath],
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            TRIANGLE_BRIDGE_PORT: String(ctx.toolBridge.port),
            TRIANGLE_BRIDGE_TOKEN: ctx.toolBridge.token,
          },
        },
      ],
    });
  },
};
