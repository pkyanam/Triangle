/**
 * Hugging Face Spaces integration.
 *
 * Calls public or private HF Spaces through the official Gradio JavaScript client,
 * which handles the modern queue-based Gradio API (`/gradio_api/call/*`) and file
 * inputs/outputs. Falls back to a raw HTTP call when `endpoint` is supplied
 * directly.
 *
 * @see https://huggingface.co/docs/hub/spaces-api-endpoints
 * @see https://huggingface.co/docs/hub/spaces-oauth
 */
import { client } from '@gradio/client';

export interface HFSpacesConfig {
  /** HF API token or OAuth access token. */
  token?: string;
  /** Override global fetch (used for testing). */
  fetch?: typeof fetch;
  /**
   * Override the Gradio client factory for testing. Receives the space name and
   * options, and must return a connected Gradio app with a `predict` method.
   */
  clientFactory?: (space: string, options?: { token?: string }) => Promise<{ predict: (route: string, payload: unknown[]) => Promise<{ data: unknown }> }>;
}

export interface HFSpaceCallOptions {
  /** Space name in `user/space` or `org/space` form. */
  space: string;
  /** Route/method name for the Space API call (e.g. `/predict` or `/shape_generation`). */
  route?: string;
  /** Payload sent to the Space; either an array of positional args or a named-params object. */
  payload?: unknown[] | Record<string, unknown>;
  /** Maximum time to wait for a result, in milliseconds. */
  timeoutMs?: number;
}

export interface HFSpaceCallResult {
  /** Raw response data from the Space. */
  data: unknown;
  /** Status reported by the Space (e.g. `complete`, `pending`). */
  status: string;
  /** Final Space URL that produced the result. */
  url: string;
}

export interface HFSpaceSummary {
  id: string;
  name: string;
  author: string;
  sdk?: string;
  tags?: string[];
  private?: boolean;
  url: string;
}

const HF_API_URL = 'https://huggingface.co/api';

export class HuggingFaceSpacesClient {
  private readonly token: string | undefined;
  private readonly fetch: typeof fetch;
  private readonly clientFactory: HFSpacesConfig['clientFactory'];

  constructor(config: HFSpacesConfig = {}) {
    this.token = config.token;
    this.fetch = config.fetch ?? globalThis.fetch;
    this.clientFactory = config.clientFactory;
  }

  /**
   * Call a Hugging Face Space Gradio API endpoint through the official Gradio JS
   * client. This handles the modern queue-based Gradio API (`/gradio_api/call/*`),
   * file uploads, and async polling.
   */
  async call(options: HFSpaceCallOptions): Promise<HFSpaceCallResult> {
    const { space, route = '/predict', payload = [] } = options;

    if (!space.includes('/')) {
      throw new Error('Space name must be in "user/space" or "org/space" form.');
    }

    const token = this.token as `hf_${string}` | undefined;
    try {
      const app = this.clientFactory
        ? await this.clientFactory(space, { ...(token ? { token } : {}) })
        : await client(space, { ...(token ? { token } : {}) });
      const result = await app.predict(route, payload as unknown[]);
      return {
        data: result.data,
        status: 'complete',
        url: `https://huggingface.co/spaces/${space}`,
      };
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      if (message.includes('Could not resolve app config') || message.includes('Space metadata')) {
        throw new Error(
          `HF Space "${space}" is unavailable (paused, sleeping, or does not exist). ` +
            `Try a different provider or wait for the Space to wake up.`,
        );
      }
      throw err;
    }
  }

  /**
   * List HF Spaces accessible to the authenticated user. Supports pagination via
   * `limit` and `skip`. If no token is set, only public Spaces are returned.
   */
  async listSpaces(options: { limit?: number; skip?: number; search?: string } = {}): Promise<HFSpaceSummary[]> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.skip !== undefined) params.set('skip', String(options.skip));
    if (options.search) params.set('search', options.search);
    const url = `${HF_API_URL}/spaces${params.toString() ? `?${params.toString()}` : ''}`;
    const res = await this.fetch(url, { headers: this.authHeaders() });
    if (!res.ok) {
      throw new Error(`HF Spaces list failed: ${res.status} ${res.statusText}`);
    }
    const items = (await res.json()) as Array<Record<string, unknown>>;
    return items.map((item) => ({
      id: String(item['_id'] ?? item['id'] ?? `${item['author']}/${item['name']}`),
      name: String(item['name']),
      author: String(item['author']),
      sdk: item['sdk'] ? String(item['sdk']) : undefined,
      tags: Array.isArray(item['tags']) ? item['tags'].map(String) : undefined,
      private: item['private'] === true,
      url: `https://huggingface.co/spaces/${item['author']}/${item['name']}`,
    }));
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    return headers;
  }
}
