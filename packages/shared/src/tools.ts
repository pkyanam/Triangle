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
  /** For object-typed nodes: nested property schemas. */
  properties?: Record<string, JsonSchemaNode>;
  /** For object/array nodes: required child keys. */
  required?: string[];
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
 * The build stage Triangle currently ships. Tools at or below this stage are wired
 * to real implementations; later-stage tools remain forward declarations. Keeping a
 * single constant means `available` flags below stay in sync with reality.
 */
export const CURRENT_STAGE = 6;

/**
 * The canonical Triangle tool catalog. Grouped by domain; expanded each stage.
 * The `available` flag reflects whether the tool is wired in the {@link CURRENT_STAGE}
 * build (Stage 2 filesystem + Stage 3 domain tooling are now live).
 */
export const TRIANGLE_TOOLS: ToolDefinition[] = [
  // --- Filesystem (Stage 2) — maps onto file:* / project:* IPC channels ---
  {
    name: 'triangle_project_tree',
    description: 'List the active project file tree.',
    parameters: { type: 'object', properties: {} },
    available: true,
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
    available: true,
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
    available: true,
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
    available: true,
    stage: 3,
  },
  {
    name: 'triangle_describe_scene',
    description:
      'Return a structured summary of the live scene graph (objects, materials, lights, camera).',
    parameters: { type: 'object', properties: {} },
    available: true,
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
    available: true,
    stage: 3,
  },
  {
    name: 'triangle_performance_snapshot',
    description: 'Return current FPS, draw calls, triangle count, and GPU memory estimates.',
    parameters: { type: 'object', properties: {} },
    available: true,
    stage: 3,
  },

  // --- Live scene manipulation (Stage 4) — transient edits to the live scene ---
  // All target objects by `name` (preferred) or `uuid`, both surfaced by
  // triangle_describe_scene. Edits reflect immediately but are reset by a
  // hot-reload; persist a change by writing the source file. See ADR 0010.
  {
    name: 'triangle_set_uniform',
    description:
      'Set a ShaderMaterial uniform on a named object with immediate visual reflection. ' +
      'value is JSON-encoded: a number "1.5", a vector "[1,0,0]", a boolean "true", or a hex color "#ff8800".',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Name or uuid of the target object.' },
        uniform: { type: 'string', description: 'Uniform name.' },
        value: { type: 'string', description: 'JSON-encoded uniform value.' },
      },
      required: ['target', 'uniform', 'value'],
    },
    available: true,
    stage: 4,
  },
  {
    name: 'triangle_set_material_color',
    description:
      "Set a color on a named object's material (e.g. color or emissive) with immediate reflection.",
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Name or uuid of the target object.' },
        color: { type: 'string', description: 'Hex color, e.g. "#ff8800".' },
        property: {
          type: 'string',
          description: 'Material color property to set (default "color"; e.g. "emissive").',
        },
      },
      required: ['target', 'color'],
    },
    available: true,
    stage: 4,
  },
  {
    name: 'triangle_set_transform',
    description:
      'Set the position, rotation (degrees), and/or scale of a named object. Provide any subset.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Name or uuid of the target object.' },
        position: { type: 'array', description: '[x, y, z] world position.', items: { type: 'number' } },
        rotationDeg: {
          type: 'array',
          description: '[x, y, z] Euler rotation in degrees.',
          items: { type: 'number' },
        },
        scale: { type: 'array', description: '[x, y, z] scale.', items: { type: 'number' } },
      },
      required: ['target'],
    },
    available: true,
    stage: 4,
  },
  {
    name: 'triangle_set_visibility',
    description: 'Show or hide a named object in the live scene.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Name or uuid of the target object.' },
        visible: { type: 'boolean', description: 'Whether the object is visible.' },
      },
      required: ['target', 'visible'],
    },
    available: true,
    stage: 4,
  },
  {
    name: 'triangle_set_light',
    description: 'Set the intensity and/or color of a named light. Provide any subset.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Name or uuid of the target light.' },
        intensity: { type: 'number', description: 'Light intensity.' },
        color: { type: 'string', description: 'Hex color, e.g. "#ffffff".' },
      },
      required: ['target'],
    },
    available: true,
    stage: 4,
  },

  // --- Strategic integrations (Stage 6) — HF Spaces + 3D asset generation ------
  {
    name: 'hf_call_space',
    description:
      'Call a Hugging Face Space API on behalf of the authenticated user. Useful for custom Spaces beyond the built-in 3D providers.',
    parameters: {
      type: 'object',
      properties: {
        space: { type: 'string', description: 'HF Space name in user/space or org/space form.' },
        route: {
          type: 'string',
          description: 'Space API route/method (default "predict").',
        },
        payload: {
          type: 'object',
          description: 'JSON payload sent to the Space API.',
        },
      },
      required: ['space'],
    },
    available: true,
    stage: 6,
  },
  {
    name: 'hf_generate_3d_asset',
    description:
      'Generate a 3D asset on Hugging Face from a text prompt or image and return a downloadable model URL.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Text prompt describing the desired 3D asset.' },
        image: {
          type: 'string',
          description: 'Optional image as a data URL (data:image/...;base64,...) for image-to-3D.',
        },
        provider: {
          type: 'string',
          description: 'HF Space provider keyword (trellis, hunyuan3d, triposr) or a user/space name. Defaults to hunyuan3d if not provided.',
        },
        endpoint: {
          type: 'string',
          description: 'Optional direct HF Space or Inference Endpoint URL.',
        },
      },
      required: ['prompt'],
    },
    available: true,
    stage: 6,
  },
  {
    name: 'download_3d_asset',
    description:
      'Download a generated 3D model URL and save it into the active project as a binary asset.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Downloadable model URL (GLB/OBJ/USDZ).' },
        path: {
          type: 'string',
          description: 'Project-relative destination path (e.g. assets/model.glb).',
        },
        format: {
          type: 'string',
          description: 'File format hint (glb, obj, usdz).',
          enum: ['glb', 'obj', 'usdz'],
        },
      },
      required: ['url', 'path'],
    },
    available: true,
    stage: 6,
  },
  {
    name: 'triangle_import_3d_asset',
    description:
      'Import a 3D model file from the active project into the live preview scene. Auto-centers and scales the result.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project-relative path to the model file.' },
        targetName: {
          type: 'string',
          description: 'Optional name for the imported root object in the scene.',
        },
      },
      required: ['path'],
    },
    available: true,
    stage: 6,
  },

  // --- Robotics simulation prep (Stage 6) — scaffolded types + snippets -----
  {
    name: 'triangle_robotics_snippet',
    description:
      'Generate a Three.js + Rapier physics simulation snippet for a robot description. Returns code the agent can paste into the project entry module.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Robot name.' },
        links: {
          type: 'array',
          description: 'Robot links with name, mass, and geometry.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              mass: { type: 'number' },
              geometry: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['box', 'sphere', 'cylinder', 'mesh'] },
                  size: { type: 'array', items: { type: 'number' }, description: '[x, y, z]' },
                  mesh: { type: 'string', description: 'Optional mesh path.' },
                },
              },
            },
            required: ['name', 'mass'],
          },
        },
        joints: {
          type: 'array',
          description: 'Robot joints between parent and child links.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string', enum: ['fixed', 'revolute', 'prismatic', 'continuous'] },
              parent: { type: 'string' },
              child: { type: 'string' },
              axis: { type: 'array', items: { type: 'number' }, description: '[x, y, z]' },
            },
            required: ['name', 'type', 'parent', 'child'],
          },
        },
      },
      required: ['name', 'links'],
    },
    available: true,
    stage: 6,
  },

  // --- World Labs Marble (Stage 6, optional stub) — reserved for future API ----
  {
    name: 'triangle_marble_world',
    description:
      '[Reserved] Generate a 3D world with World Labs Marble. Currently a stub; the API integration will be enabled once Marble is available.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Text prompt describing the world.' },
        image: { type: 'string', description: 'Optional image data URL.' },
      },
    },
    available: false,
    stage: 7,
  },
];

/** Convenience: tools available in a given build stage (inclusive). */
export function toolsForStage(stage: number): ToolDefinition[] {
  return TRIANGLE_TOOLS.filter((t) => t.stage <= stage).map((t) => ({
    ...t,
    available: t.stage <= stage,
  }));
}
