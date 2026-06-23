/**
 * Agent tool surface — the standardized description of capabilities Triangle exposes
 * to agents (Claude Agent SDK custom tools, MCP server tools, ACP, etc.).
 *
 * This is a Stage 0 deliverable: the *schema* is defined now so later stages wire
 * agents by mapping these tools onto real implementations (most map directly onto the
 * IPC contract in `ipc.ts`). Tools flagged `available: false` are forward declarations
 * for Stage 3/4 domain capabilities.
 *
 * JSON-Schema-ish shapes are kept deliberately minimal and dependency-free so they can
 * be serialized straight into an MCP `tools/list` response or a Claude tool definition.
 */

export interface ToolParameterSchema {
  type: 'object';
  properties: Record<string, JsonSchemaNode>;
  required?: string[];
}

export interface JsonSchemaNode {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
  description?: string;
  items?: JsonSchemaNode;
  enum?: string[];
}

export interface ToolDefinition {
  /** Stable, namespaced tool name. */
  name: string;
  /** One-line description shown to the agent. */
  description: string;
  parameters: ToolParameterSchema;
  /** Whether the tool is implemented in the current build. */
  available: boolean;
  /** Stage at which this tool becomes available. */
  stage: number;
}

/**
 * The canonical Triangle tool catalog. Grouped by domain; expanded each stage.
 */
export const TRIANGLE_TOOLS: ToolDefinition[] = [
  // --- Filesystem (Stage 2) — maps onto file:* / project:* IPC channels ---
  {
    name: 'triangle_project_tree',
    description: 'List the active project file tree.',
    parameters: { type: 'object', properties: {} },
    available: false,
    stage: 2,
  },
  {
    name: 'triangle_read_file',
    description: 'Read a UTF-8 text file by project-relative path.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Project-relative path.' } },
      required: ['path'],
    },
    available: false,
    stage: 2,
  },
  {
    name: 'triangle_write_file',
    description:
      'Create or overwrite a UTF-8 text file. Subject to the human approval gate when enabled.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project-relative path.' },
        content: { type: 'string', description: 'Full new file contents.' },
      },
      required: ['path', 'content'],
    },
    available: false,
    stage: 2,
  },

  // --- Three.js domain tooling (Stage 3) ---
  {
    name: 'triangle_capture_screenshot',
    description:
      'Capture the current preview framebuffer as a PNG for multimodal grounding.',
    parameters: {
      type: 'object',
      properties: {
        width: { type: 'integer', description: 'Optional output width in pixels.' },
        height: { type: 'integer', description: 'Optional output height in pixels.' },
      },
    },
    available: false,
    stage: 3,
  },
  {
    name: 'triangle_describe_scene',
    description:
      'Return a structured summary of the live scene graph (objects, materials, lights, camera).',
    parameters: { type: 'object', properties: {} },
    available: false,
    stage: 3,
  },
  {
    name: 'triangle_validate_shader',
    description: 'Compile a GLSL shader and return diagnostics without mutating the scene.',
    parameters: {
      type: 'object',
      properties: {
        stage: { type: 'string', description: 'Shader stage.', enum: ['vertex', 'fragment'] },
        source: { type: 'string', description: 'GLSL source.' },
      },
      required: ['stage', 'source'],
    },
    available: false,
    stage: 3,
  },
  {
    name: 'triangle_performance_snapshot',
    description: 'Return current FPS, draw calls, triangle count, and GPU memory estimates.',
    parameters: { type: 'object', properties: {} },
    available: false,
    stage: 3,
  },

  // --- Live scene manipulation (Stage 4) ---
  {
    name: 'triangle_set_uniform',
    description: 'Set a uniform value on a named material with immediate visual reflection.',
    parameters: {
      type: 'object',
      properties: {
        object: { type: 'string', description: 'Name/uuid of the target object.' },
        uniform: { type: 'string', description: 'Uniform name.' },
        value: { type: 'string', description: 'JSON-encoded value.' },
      },
      required: ['object', 'uniform', 'value'],
    },
    available: false,
    stage: 4,
  },
];

/** Convenience: tools available in a given build stage (inclusive). */
export function toolsForStage(stage: number): ToolDefinition[] {
  return TRIANGLE_TOOLS.filter((t) => t.stage <= stage).map((t) => ({
    ...t,
    available: t.stage <= stage,
  }));
}
