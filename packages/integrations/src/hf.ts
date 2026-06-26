/**
 * Lightweight Hugging Face 3D-generation integration.
 *
 * Calls HF Spaces through the official Gradio JavaScript client, which handles the
 * modern queue-based API (`/gradio_api/call/*`), file uploads, and polling. The
 * caller supplies a prompt or an image and receives a downloadable model URL
 * (typically GLB/OBJ/USDZ) plus the detected format.
 */
import { HuggingFaceSpacesClient, type HFSpacesConfig } from './hf-spaces.js';

export type ModelFormat = 'glb' | 'obj' | 'usdz' | 'unknown';

export interface HFGenerateOptions {
  /** Text prompt describing the desired 3D asset. */
  prompt: string;
  /** Optional image as a data URL (data:image/...;base64,...) for image-to-3D. */
  image?: string;
  /**
   * Either a known provider keyword (`hunyuan3d`, `trellis`, `triposr`, `shape-e`)
   * or a `user/space` name. When omitted, a direct endpoint must be supplied.
   */
  provider?: string;
  /** Direct HF Space or Inference Endpoint URL (legacy raw HTTP path). */
  endpoint?: string;
  /** Maximum time to wait for a generation/poll, in milliseconds. */
  timeoutMs?: number;
  /** Interval between async status polls, in milliseconds. */
  pollIntervalMs?: number;
}

export interface HFGenerateResult {
  /** URL the generated model can be downloaded from. */
  modelUrl: string | null;
  /** Detected or reported format. */
  format: ModelFormat;
  /** Status string from the provider (e.g. `complete`, `pending`). */
  status: string;
  /** Raw provider response metadata, useful for debugging. */
  metadata: Record<string, unknown>;
}

export interface HFClientConfig {
  /** HF API token or Space token. */
  token?: string;
  /** Override global fetch (used for testing). */
  fetch?: typeof fetch;
  /** Override the Gradio client factory for testing. */
  clientFactory?: HFSpacesConfig['clientFactory'];
}

interface ProviderConfig {
  space: string;
  route: string;
  /** Whether the provider can generate from text alone. */
  supportsText: boolean;
  /** Whether the provider can generate from an image. */
  supportsImage: boolean;
  /** Build the positional argument array for the Gradio endpoint. */
  args: (prompt: string, image: string | undefined) => unknown[];
  /** Extract the model URL from the Gradio result data array. */
  extractModelUrl: (data: unknown[]) => string | null;
}

function dataUrlToFileData(dataUrl: string): { path: string; meta: { _type: 'gradio.FileData' }; url: string } {
  return {
    path: dataUrl,
    meta: { _type: 'gradio.FileData' },
    url: dataUrl,
  };
}

function extractFirstFileUrl(data: unknown[]): string | null {
  for (const item of data) {
    if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>;
      const url = obj['url'];
      if (typeof url === 'string' && url.length > 0) return url;
      const path = obj['path'];
      if (typeof path === 'string' && path.length > 0) {
        if (path.startsWith('http://') || path.startsWith('https://')) return path;
      }
    }
  }
  return null;
}

const KNOWN_PROVIDERS: Record<string, ProviderConfig> = {
  hunyuan3d: {
    space: 'tencent/Hunyuan3D-2',
    route: '/shape_generation',
    supportsText: false,
    supportsImage: true,
    args: (prompt, image) => [
      prompt, // caption (text prompt, but Space disables text-to-3D by default)
      image ? dataUrlToFileData(image) : null, // image
      null, // mv_image_front
      null, // mv_image_back
      null, // mv_image_left
      null, // mv_image_right
      30, // steps
      5, // guidance_scale
      1234, // seed
      256, // octree_resolution
      true, // check_box_rembg
      8000, // num_chunks
      true, // randomize_seed
    ],
    extractModelUrl: extractFirstFileUrl,
  },
  triposr: {
    space: 'stabilityai/TripoSR',
    route: '/predict',
    supportsText: false,
    supportsImage: true,
    args: (_prompt, image) => [image ? dataUrlToFileData(image) : null],
    extractModelUrl: extractFirstFileUrl,
  },
  trellis: {
    space: 'microsoft/TRELLIS',
    route: '/predict',
    supportsText: false,
    supportsImage: true,
    args: (_prompt, image) => [image ? dataUrlToFileData(image) : null],
    extractModelUrl: extractFirstFileUrl,
  },
  'shape-e': {
    space: 'jbilcke-hf/text-to-3d',
    route: '/generate',
    supportsText: true,
    supportsImage: false,
    args: (prompt) => [prompt],
    extractModelUrl: extractFirstFileUrl,
  },
};

export const KNOWN_SPACES: Record<string, string> = Object.fromEntries(
  Object.entries(KNOWN_PROVIDERS).map(([k, v]) => [k, v.space]),
);

function detectFormat(url: string): ModelFormat {
  const lower = url.toLowerCase();
  if (lower.endsWith('.glb')) return 'glb';
  if (lower.endsWith('.obj')) return 'obj';
  if (lower.endsWith('.usdz')) return 'usdz';
  return 'unknown';
}

function providerConfig(provider: string): ProviderConfig | undefined {
  return KNOWN_PROVIDERS[provider.toLowerCase()];
}

export class HuggingFaceClient {
  private readonly token: string | undefined;
  private readonly fetch: typeof fetch;
  private readonly spaces: HuggingFaceSpacesClient;

  constructor(config: HFClientConfig = {}) {
    this.token = config.token;
    this.fetch = config.fetch ?? globalThis.fetch;
    this.spaces = new HuggingFaceSpacesClient({
      token: config.token,
      fetch: config.fetch,
      clientFactory: config.clientFactory,
    });
  }

  /** Generate a 3D asset from a prompt or image. */
  async generate3dAsset(options: HFGenerateOptions): Promise<HFGenerateResult> {
    const { prompt, image, provider, endpoint } = options;

    if (!prompt && !image) {
      throw new Error('Either prompt or image is required for 3D asset generation.');
    }

    if (endpoint) {
      // Legacy direct endpoint: fall back to a raw HTTP POST with { prompt, image }.
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
      const res = await this.fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ prompt: prompt ?? '', image: image ?? null }),
      });
      if (!res.ok) {
        throw new Error(`HF generation failed: ${res.status} ${res.statusText}`);
      }
      const data = (await res.json()) as Record<string, unknown>;
      const modelUrl = this.extractModelUrlFromResponse(data, endpoint);
      if (!modelUrl) {
        throw new Error('HF generation completed but no model URL was returned.');
      }
      return {
        modelUrl,
        format: detectFormat(modelUrl),
        status: 'complete',
        metadata: data,
      };
    }

    if (!provider) {
      throw new Error('Either a provider or an endpoint is required.');
    }

    const config = providerConfig(provider) ?? {
      space: provider,
      route: '/predict',
      supportsText: true,
      supportsImage: true,
      args: (p, i) => [p, i ? dataUrlToFileData(i) : null],
      extractModelUrl: extractFirstFileUrl,
    };

    if (!image && !config.supportsText) {
      throw new Error(`Provider "${provider}" requires an image for image-to-3D generation.`);
    }
    if (!prompt && !config.supportsImage) {
      throw new Error(`Provider "${provider}" requires a text prompt.`);
    }

    const result = await this.spaces.call({
      space: config.space,
      route: config.route,
      payload: config.args(prompt, image),
    });

    const data = result.data as unknown[];
    const modelUrl = config.extractModelUrl(data);
    if (!modelUrl) {
      throw new Error('HF generation completed but no model URL was returned.');
    }

    return {
      modelUrl,
      format: detectFormat(modelUrl),
      status: 'complete',
      metadata: { space: config.space, route: config.route, data: result.data },
    };
  }

  /** Download the model bytes from a URL. */
  async downloadModel(url: string): Promise<Uint8Array> {
    const headers: Record<string, string> = {};
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    const res = await this.fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`Download failed: ${res.status} ${res.statusText}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * Verify the configured token by calling the HF `whoami-v2` API.
   * Returns the raw HF response so callers can inspect the user/type/scopes.
   */
  async whoami(): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {};
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    const res = await this.fetch('https://huggingface.co/api/whoami-v2', { headers });
    if (!res.ok) {
      throw new Error(`HF whoami failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  private extractModelUrlFromResponse(data: Record<string, unknown>, baseUrl: string): string | null {
    const candidate = data['modelUrl'] ?? data['model_url'] ?? data['url'] ?? data['output'] ?? data['file'];
    if (typeof candidate === 'string' && candidate.length > 0) {
      if (candidate.startsWith('http://') || candidate.startsWith('https://')) return candidate;
      if (candidate.startsWith('/')) return `${new URL(baseUrl).origin}${candidate}`;
      return `${baseUrl}/${candidate}`;
    }
    const arr = data['data'];
    if (Array.isArray(arr)) return extractFirstFileUrl(arr);
    return null;
  }
}
