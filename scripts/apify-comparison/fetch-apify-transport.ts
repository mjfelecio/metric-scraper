import {
  type ApifyHttpRequest,
  type ApifyHttpResponse,
  type ApifyTransport,
} from './apify-client.js';

/**
 * `fetch`-backed transport for the Apify API.
 *
 * Direct, never proxied: the pipeline's proxy pool exists to distribute TikTok
 * traffic across exit nodes, and routing an authenticated API call carrying a
 * bearer token through a pool of anonymous third-party proxies would hand that
 * token to whoever runs them.
 */
export class FetchApifyTransport implements ApifyTransport {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) {
    this.fetchImpl = fetchImpl;
  }

  async request(request: ApifyHttpRequest): Promise<ApifyHttpResponse> {
    const init: RequestInit = {
      method: request.method,
      headers: { ...request.headers },
      signal: AbortSignal.timeout(Math.max(1, request.timeoutMs)),
    };
    if (request.body !== undefined) init.body = request.body;

    const response = await this.fetchImpl(request.url, init);
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.text(),
    };
  }
}
