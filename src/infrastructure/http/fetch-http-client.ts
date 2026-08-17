import {
  HttpError,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from '../../core/scraper/http-port.js';
import { type ProxyTarget } from '../../core/scraper/lease-ports.js';

export interface FetchHttpClientOptions {
  defaultTimeoutMs: number;
  defaultHeaders?: Readonly<Record<string, string>> | undefined;
  /** Injected for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch | undefined;
  /**
   * Builds a per-request transport agent for a proxy.
   *
   * Node's global `fetch` has no built-in proxy support, and this project does
   * not guess which proxy transport will be used. Wire this up (for example
   * with `undici`'s `ProxyAgent`) when the proxy vendor is known; until then a
   * request that requires a proxy fails loudly instead of silently going direct.
   */
  dispatcherFactory?: ((target: ProxyTarget) => unknown) | undefined;
}

/**
 * `fetch`-based adapter for the `HttpClient` port.
 *
 * Deliberately thin and platform-agnostic: it does transport concerns only
 * (timeouts, headers, redirects, proxy dispatch, structured errors). No
 * TikTok/Instagram specifics belong here.
 */
export class FetchHttpClient implements HttpClient {
  private readonly options: FetchHttpClientOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FetchHttpClientOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async request(request: HttpRequest): Promise<HttpResponse> {
    const timeoutMs = request.timeoutMs ?? this.options.defaultTimeoutMs;
    const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
    if (request.signal !== undefined) {
      signals.push(request.signal);
    }

    const headers: Record<string, string> = { ...this.options.defaultHeaders, ...request.headers };
    if (request.cookie !== undefined && request.cookie.length > 0) {
      headers['cookie'] = request.cookie;
    }

    const init: RequestInit = {
      method: request.method ?? 'GET',
      headers,
      redirect: request.redirect ?? 'follow',
      signal: AbortSignal.any(signals),
    };
    if (request.body !== undefined) {
      init.body = request.body;
    }

    const proxy = request.proxy ?? null;
    if (proxy !== null) {
      if (this.options.dispatcherFactory === undefined) {
        throw new HttpError({
          code: 'config_error',
          message:
            'a proxy was assigned but no dispatcherFactory is configured; ' +
            'refusing to fall back to a direct connection',
        });
      }
      // `dispatcher` is an undici-specific RequestInit extension, and its type
      // lives in a package this project deliberately does not depend on yet.
      Object.assign(init, { dispatcher: this.options.dispatcherFactory(proxy) });
    }

    const startedAt = Date.now();
    let response: Response;
    try {
      response = await this.fetchImpl(request.url, init);
    } catch (error) {
      throw toHttpError(error, request.url);
    }

    let body: string;
    try {
      body = await response.text();
    } catch (error) {
      throw toHttpError(error, request.url);
    }

    return {
      url: response.url === '' ? request.url : response.url,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body,
      redirected: response.redirected,
      durationMs: Date.now() - startedAt,
    };
  }
}

function toHttpError(error: unknown, url: string): HttpError {
  if (error instanceof HttpError) return error;
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new HttpError({
      code: 'timeout',
      message: `request to ${url} timed out or was aborted`,
      cause: error,
    });
  }
  return new HttpError({
    code: 'network_error',
    message: `request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
    cause: error,
  });
}
