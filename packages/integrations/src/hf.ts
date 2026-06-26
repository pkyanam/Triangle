/**
 * Lightweight Hugging Face 3D-generation integration.
 *
 * Supports direct inference endpoints and HF Spaces (Gradio /api/predict). The
 * caller supplies a prompt or an image and receives a downloadable model URL
 * (typically GLB/OBJ/USDZ) plus the detected format. The fetch implementation
 * is injectable so tests can mock the network.
 */

export type ModelFormat = 'glb' | 'obj' | 'usdz' | 'unknown';

export interface HFGenerateOptions {
  /** Text prompt describing the desired 3D asset. */
  prompt: string;
  /** Optional image as a data URL (data:image/...;base64,...) for image-to-3D. */
  image?: string;
  /**
   * Either a known provider keyword (`trellis`, `hunyuan3d`, `triposr`) or a
   * `user/space` name. When omitted, a direct endpoint must be supplied.
   */
  provider?: string;
  /** Direct HTTP URL that accepts { prompt, image? } and returns a model URL. */
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
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 2000;

const KNOWN_SPACES: Record<string, string> = {
  trellis: 'JeffreyXiang/TRELLIS-mini',
  hunyuan3d: 'tencent/Hunyuan3D-2-mini',
  triposr: 'stabilityai/TripoSR',
};

function detectFormat(url: string): ModelFormat {
  const lower = url.toLowerCase();
  if (lower.endsWith('.glb')) return 'glb';
  if (lower.endsWith('.obj')) return 'obj';
  if (lower.endsWith('.usdz')) return 'usdz';
  return 'unknown';
}

function spaceEndpoint(space: string): string {
  return `https://huggingface.co/spaces/${space}/api/predict`;
}

function providerSpace(provider: string): string | undefined {
  const key = provider.toLowerCase();
  return KNOWN_SPACES[key] ?? (provider.includes('/') ? provider : undefined);
}

export class HuggingFaceClient {
  private readonly token: string | undefined;
  private readonly fetch: typeof fetch;

  constructor(config: HFClientConfig = {}) {
    this.token = config.token;
    this.fetch = config.fetch ?? globalThis.fetch;
  }

  /** Generate a 3D asset from a prompt or image. */
  async generate3dAsset(options: HFGenerateOptions): Promise<HFGenerateResult> {
    const {
      prompt,
      image,
      provider,
      endpoint,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    } = options;

    if (!prompt && !image) {
      throw new Error('Either prompt or image is required for 3D asset generation.');
    }

    const url = endpoint ?? (provider ? spaceEndpoint(providerSpace(provider) ?? provider) : undefined);
    if (!url) {
      throw new Error('Either a provider or an endpoint is required.');
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;

    const deadline = Date.now() + timeoutMs;

    // For direct endpoints, send the generation payload and optionally poll.
    const initial = await this.fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ prompt: prompt ?? '', image: image ?? null }),
    });

    if (!initial.ok) {
      throw new Error(`HF generation failed: ${initial.status} ${initial.statusText}`);
    }

    const first = (await initial.json()) as Record<string, unknown>;
    let status = String(first['status'] ?? first['job_status'] ?? 'complete');
    let modelUrl = this.extractModelUrl(first, url);

    while (status === 'pending' && Date.now() < deadline) {
      await this.sleep(pollIntervalMs);
      const pollUrl = first['poll_url'] ? String(first['poll_url']) : url;
      const poll = await this.fetch(pollUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ prompt: prompt ?? '', image: image ?? null }),
      });
      if (!poll.ok) {
        throw new Error(`HF poll failed: ${poll.status} ${poll.statusText}`);
      }
      const data = (await poll.json()) as Record<string, unknown>;
      status = String(data['status'] ?? data['job_status'] ?? 'complete');
      modelUrl = this.extractModelUrl(data, url) ?? modelUrl;
    }

    if (!modelUrl) {
      throw new Error('HF generation completed but no model URL was returned.');
    }

    return {
      modelUrl,
      format: detectFormat(modelUrl),
      status,
      metadata: first,
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

  private extractModelUrl(data: Record<string, unknown>, baseUrl: string): string | null {
    const candidate =
      data['modelUrl'] ??
      data['model_url'] ??
      data['url'] ??
      data['output'] ??
      data['file'];

    if (typeof candidate === 'string' && candidate.length > 0) {
      if (candidate.startsWith('http://') || candidate.startsWith('https://')) return candidate;
      if (candidate.startsWith('/')) {
        const origin = new URL(baseUrl).origin;
        return `${origin}${candidate}`;
      }
      // HF Spaces file references from Gradio.
      if (candidate.startsWith('file=')) {
        return `${baseUrl.replace(/\/api\/predict$/, '')}/${candidate}`;
      }
      return `${baseUrl}/${candidate}`;
    }

    // Gradio `data` array may contain file paths.
    const arr = data['data'];
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (typeof item === 'string') {
          const guessed = this.extractModelUrl({ modelUrl: item }, baseUrl);
          if (guessed) return guessed;
        } else if (item && typeof item === 'object') {
          const path = (item as Record<string, unknown>)['path'];
          if (typeof path === 'string') {
            return this.extractModelUrl({ modelUrl: path }, baseUrl);
          }
        }
      }
    }

    return null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export { KNOWN_SPACES };
