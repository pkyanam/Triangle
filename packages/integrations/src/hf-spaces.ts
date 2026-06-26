/**
 * Hugging Face Spaces integration.
 *
 * Lets Triangle call public or private HF Spaces on behalf of an authenticated user.
 * Spaces expose a Gradio `/api/predict` endpoint and newer `/api/run` endpoints. This
 * client supports both, plus listing Spaces the caller has access to.
 *
 * @see https://huggingface.co/docs/hub/spaces-overview
 * @see https://huggingface.co/docs/hub/spaces-oauth
 */

export interface HFSpacesConfig {
  /** HF API token or OAuth access token. */
  token?: string;
  /** Override global fetch (used for testing). */
  fetch?: typeof fetch;
}

export interface HFSpaceCallOptions {
  /** Space name in `user/space` or `org/space` form. */
  space: string;
  /** Route/method name for the Space API call (e.g. `predict`). */
  route?: string;
  /** Payload sent to the Space. */
  payload?: Record<string, unknown>;
  /** Maximum time to wait for a result, in milliseconds. */
  timeoutMs?: number;
  /** Interval between async status polls, in milliseconds. */
  pollIntervalMs?: number;
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

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const HF_API_URL = 'https://huggingface.co/api';

export class HuggingFaceSpacesClient {
  private readonly token: string | undefined;
  private readonly fetch: typeof fetch;

  constructor(config: HFSpacesConfig = {}) {
    this.token = config.token;
    this.fetch = config.fetch ?? globalThis.fetch;
  }

  /**
   * Call a Hugging Face Space Gradio API endpoint. Defaults to `/api/predict` but
   * can be overridden for newer Spaces that expose `/api/run/{route}` endpoints.
   *
   * If the response contains a `status` of `pending`, the client polls the Space
   * until the job completes or the timeout is reached.
   */
  async call(options: HFSpaceCallOptions): Promise<HFSpaceCallResult> {
    const {
      space,
      route = 'predict',
      payload = {},
      timeoutMs = DEFAULT_TIMEOUT_MS,
      pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    } = options;

    if (!space.includes('/')) {
      throw new Error('Space name must be in "user/space" or "org/space" form.');
    }

    const url = this.spaceApiUrl(space, route);
    const headers = this.authHeaders();
    const deadline = Date.now() + timeoutMs;

    const initial = await this.fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!initial.ok) {
      throw new Error(`HF Space call failed: ${initial.status} ${initial.statusText}`);
    }

    const first = (await initial.json()) as Record<string, unknown>;
    let status = String(first['status'] ?? first['job_status'] ?? 'complete');
    let data: unknown = first['data'] ?? first;

    while (status === 'pending' && Date.now() < deadline) {
      await sleep(pollIntervalMs);
      const poll = await this.fetch(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!poll.ok) {
        throw new Error(`HF Space poll failed: ${poll.status} ${poll.statusText}`);
      }
      const body = (await poll.json()) as Record<string, unknown>;
      status = String(body['status'] ?? body['job_status'] ?? 'complete');
      data = body['data'] ?? body;
    }

    return { data, status, url };
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

  private spaceApiUrl(space: string, route: string): string {
    return `https://huggingface.co/spaces/${space}/api/${route}`;
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    return headers;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
