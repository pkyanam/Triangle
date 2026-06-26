import { z } from 'zod';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ModelInfo } from '@triangle/shared';
import type { TriangleConfig } from '../config.js';
import { resolveClaudeAuth } from './claude-auth.js';
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
  'mcp__triangle__triangle_capture_screenshot',
  'mcp__triangle__triangle_describe_scene',
  'mcp__triangle__triangle_validate_shader',
  'mcp__triangle__triangle_performance_snapshot',
  'mcp__triangle__triangle_set_uniform',
  'mcp__triangle__triangle_set_material_color',
  'mcp__triangle__triangle_set_transform',
  'mcp__triangle__triangle_set_visibility',
  'mcp__triangle__triangle_set_light',
];

const SYSTEM_PROMPT =
  'You are the Triangle agent, an expert Three.js / WebGL developer working inside a live ' +
  'preview engine. The active project is a Triangle project whose entry module is hot-reloaded ' +
  'on save. Use the triangle_* tools to inspect and edit project files (paths are project-' +
  'relative). Entry modules receive an injected THREE context and must not use bare imports. ' +
  'For visual grounding you can call triangle_capture_screenshot (saves a PNG you can then Read), ' +
  'triangle_describe_scene (the live scene graph), triangle_validate_shader (compile GLSL and get ' +
  'diagnostics before writing it to disk), and triangle_performance_snapshot. You can also drive ' +
  'the live scene directly for fast iteration: triangle_set_uniform, triangle_set_material_color, ' +
  'triangle_set_transform, triangle_set_visibility, and triangle_set_light all take a target (an ' +
  'object name or uuid from triangle_describe_scene) and reflect immediately. These live edits are ' +
  'transient — a hot-reload (file save) resets them — so once a look is right, persist it by writing ' +
  'the source file. Prefer validating a shader and capturing a screenshot to confirm your changes ' +
  'look right. Make minimal, targeted edits and briefly explain what you changed.';

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
    const auth = await resolveClaudeAuth(config);
    if (!auth) {
      return {
        available: false,
        reason:
          'Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN (env or .triangle/config.json), or run `claude login`.',
      };
    }
    return { available: true, reason: `Authenticated via ${auth.source}.` };
  },

  async models(): Promise<ModelInfo[]> {
    return [
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', description: 'Balanced quality and speed' },
      { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', description: 'Highest capability' },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', description: 'Fastest, lightweight' },
    ];
  },

  async run(ctx: RunContext): Promise<void> {
    const { prompt, projectRoot, config, toolset, emit, signal } = ctx;
    const auth = await resolveClaudeAuth(config);
    if (!auth) {
      throw new Error(
        'No Claude authentication found. Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN (env or .triangle/config.json), or run `claude login`.',
      );
    }

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
      tool(
        'triangle_capture_screenshot',
        'Capture the current preview framebuffer as a PNG (saved to the project) for visual grounding. Read the returned path to view it.',
        {
          width: z.number().int().positive().optional().describe('Optional output width in pixels.'),
          height: z.number().int().positive().optional().describe('Optional output height in pixels.'),
        },
        async ({ width, height }) => {
          const text = await toolset.captureScreenshot({ width, height });
          return { content: [{ type: 'text' as const, text }] };
        },
      ),
      tool(
        'triangle_describe_scene',
        'Return a structured summary of the live scene graph (objects, materials, lights, camera).',
        {},
        async () => {
          const text = await toolset.describeScene();
          return { content: [{ type: 'text' as const, text }] };
        },
      ),
      tool(
        'triangle_validate_shader',
        'Compile a GLSL shader against the live GL context and return diagnostics, without mutating the scene.',
        {
          stage: z.enum(['vertex', 'fragment']).describe('Shader stage.'),
          source: z.string().describe('GLSL source.'),
        },
        async ({ stage, source }) => {
          const text = await toolset.validateShader(stage, source);
          return { content: [{ type: 'text' as const, text }] };
        },
      ),
      tool(
        'triangle_performance_snapshot',
        'Return current FPS, draw calls, triangle count, and a GPU-memory estimate.',
        {},
        async () => {
          const text = await toolset.performanceSnapshot();
          return { content: [{ type: 'text' as const, text }] };
        },
      ),
      tool(
        'triangle_set_uniform',
        'Set a ShaderMaterial uniform on a live object (transient until hot-reload). value is JSON-encoded: a number "1.5", a vector "[1,0,0]", a boolean "true", or a hex color "#ff8800".',
        {
          target: z.string().describe('Object name or uuid (from triangle_describe_scene).'),
          uniform: z.string().describe('Uniform name.'),
          value: z.string().describe('JSON-encoded uniform value.'),
        },
        async ({ target, uniform, value }) => {
          const text = await toolset.setUniform(target, uniform, value);
          return { content: [{ type: 'text' as const, text }] };
        },
      ),
      tool(
        'triangle_set_material_color',
        "Set a color on a live object's material (transient until hot-reload).",
        {
          target: z.string().describe('Object name or uuid.'),
          color: z.string().describe('Hex color, e.g. "#ff8800".'),
          property: z
            .string()
            .optional()
            .describe('Material color property (default "color"; e.g. "emissive").'),
        },
        async ({ target, color, property }) => {
          const text = await toolset.setMaterialColor(target, color, property);
          return { content: [{ type: 'text' as const, text }] };
        },
      ),
      tool(
        'triangle_set_transform',
        'Set position, rotation (degrees), and/or scale of a live object (transient until hot-reload). Provide any subset.',
        {
          target: z.string().describe('Object name or uuid.'),
          position: z.array(z.number()).length(3).optional().describe('[x, y, z] world position.'),
          rotationDeg: z.array(z.number()).length(3).optional().describe('[x, y, z] degrees.'),
          scale: z.array(z.number()).length(3).optional().describe('[x, y, z] scale.'),
        },
        async ({ target, position, rotationDeg, scale }) => {
          const text = await toolset.setTransform(target, { position, rotationDeg, scale });
          return { content: [{ type: 'text' as const, text }] };
        },
      ),
      tool(
        'triangle_set_visibility',
        'Show or hide a live object (transient until hot-reload).',
        {
          target: z.string().describe('Object name or uuid.'),
          visible: z.boolean().describe('Whether the object is visible.'),
        },
        async ({ target, visible }) => {
          const text = await toolset.setVisibility(target, visible);
          return { content: [{ type: 'text' as const, text }] };
        },
      ),
      tool(
        'triangle_set_light',
        'Set the intensity and/or color of a live light (transient until hot-reload). Provide any subset.',
        {
          target: z.string().describe('Light name or uuid.'),
          intensity: z.number().optional().describe('Light intensity.'),
          color: z.string().optional().describe('Hex color, e.g. "#ffffff".'),
        },
        async ({ target, intensity, color }) => {
          const text = await toolset.setLight(target, { intensity, color });
          return { content: [{ type: 'text' as const, text }] };
        },
      ),
      tool(
        'hf_generate_3d_asset',
        'Generate a 3D asset on Hugging Face from a text prompt or image and return a downloadable model URL.',
        {
          prompt: z.string().describe('Text prompt describing the desired 3D asset.'),
          image: z.string().optional().describe('Optional image as a data URL for image-to-3D.'),
          provider: z.string().optional().describe('HF Space provider keyword (trellis, hunyuan3d, triposr) or user/space.'),
          endpoint: z.string().optional().describe('Direct HF Space or Inference Endpoint URL.'),
        },
        async ({ prompt, image, provider, endpoint }) => {
          const text = await toolset.hfGenerate3dAsset(prompt, image, provider, endpoint);
          return { content: [{ type: 'text' as const, text }] };
        },
      ),
      tool(
        'download_3d_asset',
        'Download a generated 3D model and save it into the active project as a binary asset.',
        {
          url: z.string().describe('Downloadable model URL (GLB/OBJ/USDZ).'),
          path: z.string().describe('Project-relative destination path (e.g. assets/model.glb).'),
          format: z.enum(['glb', 'obj', 'usdz']).optional().describe('Format hint.'),
        },
        async ({ url, path, format }) => {
          const text = await toolset.download3dAsset(url, path, format);
          return { content: [{ type: 'text' as const, text }] };
        },
      ),
      tool(
        'triangle_import_3d_asset',
        'Import a 3D model file from the active project into the live preview scene. Auto-centers and scales it.',
        {
          path: z.string().describe('Project-relative path to the model file.'),
          targetName: z.string().optional().describe('Name for the imported root object.'),
        },
        async ({ path, targetName }) => {
          const text = await toolset.import3dAsset(path, targetName);
          return { content: [{ type: 'text' as const, text }] };
        },
      ),
      tool(
        'triangle_robotics_snippet',
        'Generate a Three.js + Rapier physics simulation snippet for a robot. Returns code to paste into the entry module.',
        {
          name: z.string().describe('Robot name.'),
          links: z.array(z.object({ name: z.string(), mass: z.number(), geometry: z.any().optional() })).describe('Robot links.'),
          joints: z.array(z.object({ name: z.string(), type: z.enum(['fixed', 'revolute', 'prismatic', 'continuous']), parent: z.string(), child: z.string(), axis: z.array(z.number()).length(3).optional() })).optional().describe('Robot joints.'),
        },
        async ({ name, links, joints }) => {
          const text = await toolset.roboticsSnippet(name, links, joints);
          return { content: [{ type: 'text' as const, text }] };
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
      allowedTools: [
        ...TRIANGLE_TOOL_NAMES,
        'Read',
        'Grep',
        'Glob',
        'mcp__triangle__hf_generate_3d_asset',
        'mcp__triangle__download_3d_asset',
        'mcp__triangle__triangle_import_3d_asset',
        'mcp__triangle__triangle_robotics_snippet',
      ],
      // Keep writes confined to ProjectManager: block the SDK's own disk-mutating tools.
      disallowedTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch'],
      permissionMode: 'default',
      abortController,
      // Don't auto-load arbitrary local .claude/ settings; Triangle drives configuration.
      settingSources: [],
      pathToClaudeCodeExecutable: config.claudeExecutablePath,
      env:
        auth.type === 'oauth'
          ? { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: auth.token, ANTHROPIC_API_KEY: undefined }
          : { ...process.env, ANTHROPIC_API_KEY: auth.token, CLAUDE_CODE_OAUTH_TOKEN: undefined },
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
