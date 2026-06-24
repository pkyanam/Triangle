import { z } from 'zod';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { TriangleConfig } from '../config.js';
import type { AgentHarness, RunContext } from './harness.js';

/**
 * Claude Agent SDK harness. Spawns the SDK's in-process agent loop and exposes the
 * Triangle filesystem tools as an in-process MCP server (`createSdkMcpServer`), so every
 * file operation flows through `ProjectManager` and the human-approval gate rather than
 * the SDK's built-in disk tools (which we disallow). See ADR 0005.
 */

const TRIANGLE_TOOL_NAMES = [
  'mcp__triangle__triangle_project_tree',
  'mcp__triangle__triangle_read_file',
  'mcp__triangle__triangle_write_file',
];

const SYSTEM_PROMPT =
  'You are the Triangle agent, an expert Three.js / WebGL developer working inside a live ' +
  'preview engine. The active project is a Triangle project whose entry module is hot-reloaded ' +
  'on save. Use the triangle_* tools to inspect and edit project files (paths are project-' +
  'relative). Entry modules receive an injected THREE context and must not use bare imports. ' +
  'Make minimal, targeted edits and briefly explain what you changed.';

/** Extract concatenated text from a Beta assistant message's content blocks. */
function extractText(message: { content?: unknown }): string {
  const blocks = Array.isArray(message.content) ? message.content : [];
  return blocks
    .filter((b): b is { type: 'text'; text: string } => {
      const block = b as { type?: string; text?: unknown };
      return block.type === 'text' && typeof block.text === 'string';
    })
    .map((b) => b.text)
    .join('')
    .trim();
}

function toolUseNames(message: { content?: unknown }): string[] {
  const blocks = Array.isArray(message.content) ? message.content : [];
  return blocks
    .filter((b) => (b as { type?: string }).type === 'tool_use')
    .map((b) => String((b as { name?: string }).name ?? 'tool'));
}

export const claudeHarness: AgentHarness = {
  id: 'claude',
  label: 'Claude Agent SDK',

  async availability(config: TriangleConfig) {
    try {
      await import('@anthropic-ai/claude-agent-sdk');
    } catch {
      return { available: false, reason: 'Claude Agent SDK is not installed.' };
    }
    if (!config.anthropicApiKey) {
      return {
        available: false,
        reason: 'Set ANTHROPIC_API_KEY (env or .triangle/config.json).',
      };
    }
    return { available: true };
  },

  async run(ctx: RunContext): Promise<void> {
    const { prompt, projectRoot, config, toolset, emit, signal } = ctx;
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const { query, tool, createSdkMcpServer } = sdk;

    // Map the Triangle toolset onto SDK tool definitions (these emit traces internally).
    const tools = [
      tool('triangle_project_tree', 'List the active project file tree.', {}, async () => {
        const text = await toolset.projectTree();
        return { content: [{ type: 'text' as const, text }] };
      }),
      tool(
        'triangle_read_file',
        'Read a UTF-8 text file by project-relative path.',
        { path: z.string().describe('Project-relative path.') },
        async ({ path }) => {
          const text = await toolset.readFile(path);
          return { content: [{ type: 'text' as const, text }] };
        },
      ),
      tool(
        'triangle_write_file',
        'Create or overwrite a UTF-8 text file. Subject to the human approval gate.',
        {
          path: z.string().describe('Project-relative path.'),
          content: z.string().describe('Full new file contents.'),
        },
        async ({ path, content }) => {
          const summary = await toolset.writeFile(path, content);
          return { content: [{ type: 'text' as const, text: summary }] };
        },
      ),
    ];

    const triangleServer = createSdkMcpServer({ name: 'triangle', version: '0.2.0', tools });

    // Bridge our cancellation signal to the SDK's AbortController.
    const abortController = new AbortController();
    if (signal.aborted) abortController.abort();
    else signal.addEventListener('abort', () => abortController.abort(), { once: true });

    const options: Options = {
      cwd: projectRoot,
      model: config.claudeModel,
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: { triangle: triangleServer },
      allowedTools: [...TRIANGLE_TOOL_NAMES, 'Read', 'Grep', 'Glob'],
      // Keep writes confined to ProjectManager: block the SDK's own disk-mutating tools.
      disallowedTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch'],
      permissionMode: 'default',
      abortController,
      // Don't auto-load arbitrary local .claude/ settings; Triangle drives configuration.
      settingSources: [],
      pathToClaudeCodeExecutable: config.claudeExecutablePath,
      env: { ...process.env, ANTHROPIC_API_KEY: config.anthropicApiKey },
      stderr: (data: string) => emit({ type: 'log', level: 'info', text: data.trimEnd() }),
    };

    for await (const message of query({ prompt, options }) as AsyncIterable<SDKMessage>) {
      if (signal.aborted) return;
      if (message.type === 'assistant') {
        const text = extractText(message.message as { content?: unknown });
        if (text) emit({ type: 'assistant', messageId: message.uuid, text });
        for (const name of toolUseNames(message.message as { content?: unknown })) {
          if (!name.startsWith('triangle_') && !name.startsWith('mcp__triangle')) {
            emit({ type: 'log', level: 'info', text: `Using built-in tool: ${name}` });
          }
        }
      } else if (message.type === 'result') {
        if (message.subtype !== 'success') {
          const reason =
            'is_error' in message && message.is_error
              ? (message as { result?: string }).result
              : message.subtype;
          throw new Error(`Claude run ended: ${reason ?? 'unknown error'}`);
        }
      }
    }
  },
};
