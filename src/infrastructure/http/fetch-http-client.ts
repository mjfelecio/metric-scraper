import {
  HttpError,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from '../../core/scraper/http-port.js';
import { type ProxyTarget } from '../../core/scraper/lease-ports.js';
import { redactEntry } from '../proxy/proxy-config.js';

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
  /**
   * Transport used when no proxy is assigned.
   *
   * Without this the direct path bypasses any composed dispatcher, so a run
   * with no proxies would report zero bandwidth. Passed explicitly rather than
   * set globally, so nothing outside this client is affected.
   */
  defaultDispatcher?: unknown;
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
    } else if (this.options.defaultDispatcher !== undefined) {
      Object.assign(init, { dispatcher: this.options.defaultDispatcher });
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

/** Connect-phase codes: the socket never opened, so this is a `timeout`, not a `network_error`. */
const CONNECT_TIMEOUT_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT']);

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

  // undici's fetch wraps every transport failure in `TypeError: fetch failed`,
  // whose own message is always that one string. The useful part — ECONNREFUSED,
  // UND_ERR_CONNECT_TIMEOUT, ECONNRESET, ENOTFOUND — sits one level down in
  // `.cause` and was previously discarded, making every proxy failure read
  // identically regardless of cause.
  const terminal = terminalCause(error);
  if (terminal !== null) {
    const isConnectTimeout = terminal.code !== null && CONNECT_TIMEOUT_CODES.has(terminal.code);
    const detail =
      terminal.code !== null
        ? `${terminal.code} — ${redactEntry(terminal.message)}`
        : redactEntry(terminal.message);
    return new HttpError({
      code: isConnectTimeout ? 'timeout' : 'network_error',
      message: isConnectTimeout
        ? `request to ${url} timed out connecting: ${detail}`
        : `request to ${url} failed: ${detail}`,
      cause: error,
      causeCode: terminal.code ?? undefined,
    });
  }

  return new HttpError({
    code: 'network_error',
    message: `request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
    cause: error,
  });
}

interface TerminalCause {
  /** A system/library error code, when the chain had one (e.g. `ECONNREFUSED`). */
  readonly code: string | null;
  readonly message: string;
}

/**
 * Walks `error.cause` to the deepest error, preferring the first one that
 * carries a system/library error code (Node's `ECONNREFUSED` etc., undici's
 * `UND_ERR_CONNECT_TIMEOUT` etc.) over a generic wrapper message like
 * `fetch failed`. Cycle-safe via `seen`.
 *
 * Returns `null` only when `error` itself has no cause to walk to — in that
 * case its own `.message` is already the most specific thing available, and
 * the caller falls back to the pre-existing behaviour rather than being
 * handed a `code: null` that adds nothing.
 */
function terminalCause(error: unknown): TerminalCause | null {
  if (!(error instanceof Error)) return null;

  let current: Error = error;
  const seen = new Set<Error>([error]);

  for (;;) {
    const code = (current as NodeJS.ErrnoException).code;
    if (typeof code === 'string') {
      return { code, message: current.message };
    }
    const next = current.cause;
    if (!(next instanceof Error) || seen.has(next)) {
      return current === error ? null : { code: null, message: current.message };
    }
    seen.add(next);
    current = next;
  }
}
