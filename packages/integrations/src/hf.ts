/**
 * Lightweight Hugging Face 3D-generation integration.
 *
 * Calls HF Spaces through the official Gradio JavaScript client, which handles the
 * modern queue-based API (`/gradio_api/call/*`), file uploads, and polling. The
 * caller supplies a prompt or an image and receives a downloadable model URL
 * (typically GLB/OBJ/USDZ) plus the detected format.
 */
import { handle_file } from '@gradio/client';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
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
  args: (prompt: string, imageHandle: unknown) => unknown[];
  /** Extract the model URL from the Gradio result data array. */
  extractModelUrl: (data: unknown[], spaceUrl: string) => string | null;
}

interface TempFile {
  /** The Gradio handle_file() result to pass in the args array. */
  handle: unknown;
  /** Temp file path to delete after the Space call completes. */
  path: string;
}

/**
 * Convert a `data:image/...;base64,...` URL into a Gradio file handle by
 * writing the decoded bytes to a temp file and calling `handle_file()`.
 *
 * We use `handle_file` (which creates a Gradio `Command` object) rather than
 * passing a raw `Buffer` because the Gradio client's `walk_and_store_blobs`
 * relies on `data instanceof globalThis.Buffer`, which can fail in bundled
 * Electron environments where the `Buffer` constructor is from a different
 * realm. The `Command` path is processed by `process_local_file_commands`,
 * which uses `fs.readFile` and is not susceptible to realm issues.
 *
 * The caller must delete the temp file after the Space call completes.
 */
function dataUrlToGradioFile(dataUrl: string): TempFile {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('Invalid data URL: missing base64 payload.');
  const header = dataUrl.slice(0, comma);
  const base64 = dataUrl.slice(comma + 1);
  if (!header.startsWith('data:') || !header.includes('base64')) {
    throw new Error('Invalid data URL: expected a base64 data URL.');
  }
  const mimeMatch = header.match(/data:([^;]+)/);
  const mime = mimeMatch?.[1] ?? 'application/octet-stream';
  const ext = mime === 'image/png' ? '.png'
    : mime === 'image/jpeg' ? '.jpg'
    : mime === 'image/webp' ? '.webp'
    : mime === 'image/gif' ? '.gif'
    : '';
  const tempPath = join(tmpdir(), `triangle-hf-${randomUUID()}${ext}`);
  writeFileSync(tempPath, Buffer.from(base64, 'base64'));
  return { handle: handle_file(tempPath), path: tempPath };
}

/**
 * Scan a Gradio result data array for the first downloadable file URL. Gradio
 * serialises file outputs as FileData objects whose `url` is usually a fully
 * qualified download URL. Some Spaces (or older Gradio versions) only populate
 * a server-side `path`; in that case we construct a Gradio file URL from the
 * Space's base URL: `{spaceUrl}/gradio_api/file={path}`.
 */
function extractFirstFileUrl(data: unknown[], spaceUrl: string): string | null {
  for (const item of data) {
    const url = extractFileUrl(item, spaceUrl);
    if (url) return url;
  }
  return null;
}

function extractFileUrl(item: unknown, spaceUrl: string): string | null {
  if (typeof item === 'string' && isHttpUrl(item)) return item;
  if (!item || typeof item !== 'object') return null;
  const obj = item as Record<string, unknown>;

  const url = obj['url'];
  if (typeof url === 'string' && url.length > 0) return url;

  const path = obj['path'];
  if (typeof path === 'string' && path.length > 0) {
    if (isHttpUrl(path)) return path;
    // Server-side file path → construct a Gradio file download URL.
    return `${spaceUrl.replace(/\/$/, '')}/gradio_api/file=${path}`;
  }

  // Some Gradio responses nest FileData inside `value` or wrapper objects.
  const value = obj['value'];
  if (value && typeof value === 'object') {
    const nested = extractFileUrl(value, spaceUrl);
    if (nested) return nested;
  }
  return null;
}

function isHttpUrl(s: string): boolean {
  return s.startsWith('http://') || s.startsWith('https://');
}

const KNOWN_PROVIDERS: Record<string, ProviderConfig> = {
  hunyuan3d: {
    space: 'tencent/Hunyuan3D-2',
    route: '/shape_generation',
    supportsText: false,
    supportsImage: true,
    // 13 params per the live Space API (confirmed via /gradio_api/info):
    //   caption, image, mv_image_front, mv_image_back, mv_image_left,
    //   mv_image_right, steps, guidance_scale, seed, octree_resolution,
    //   check_box_rembg, num_chunks, randomize_seed
    args: (prompt, imageHandle) => [
      prompt, // caption
      imageHandle, // image
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
    args: (_prompt, imageHandle) => [imageHandle],
    extractModelUrl: extractFirstFileUrl,
  },
  trellis: {
    space: 'microsoft/TRELLIS',
    route: '/predict',
    supportsText: false,
    supportsImage: true,
    args: (_prompt, imageHandle) => [imageHandle],
    extractModelUrl: extractFirstFileUrl,
  },
  'shape-e': {
    space: 'hysts/Shap-E',
    route: '/text-to-3d',
    supportsText: true,
    supportsImage: false,
    args: (prompt) => [prompt, 0, 15, 64],
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
      args: (p: string, imgHandle: unknown) => [p, imgHandle],
      extractModelUrl: extractFirstFileUrl,
    };

    if (!image && !config.supportsText) {
      throw new Error(`Provider "${provider}" requires an image for image-to-3D generation.`);
    }
    if (!prompt && !config.supportsImage) {
      throw new Error(`Provider "${provider}" requires a text prompt.`);
    }

    // Convert the image data URL to a Gradio file handle via a temp file.
    // The temp file is deleted after the Space call completes (or throws).
    const tempFile = image ? dataUrlToGradioFile(image) : null;
    try {
      const result = await this.spaces.call({
        space: config.space,
        route: config.route,
        payload: config.args(prompt, tempFile?.handle ?? null),
      });

      const data = result.data as unknown[];
      const modelUrl = config.extractModelUrl(data, result.url);
      if (!modelUrl) {
        throw new Error(
          `HF generation completed but no model URL was returned. ` +
            `Space: ${config.space}, route: ${config.route}, data: ${JSON.stringify(data).slice(0, 500)}`,
        );
      }

      return {
        modelUrl,
        format: detectFormat(modelUrl),
        status: 'complete',
        metadata: { space: config.space, route: config.route, data: result.data },
      };
    } finally {
      if (tempFile) {
        try { unlinkSync(tempFile.path); } catch { /* best-effort cleanup */ }
      }
    }
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
    if (Array.isArray(arr)) return extractFirstFileUrl(arr, baseUrl);
    return null;
  }
}
