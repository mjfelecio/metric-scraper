import { ScrapeError } from '../models/errors.js';

import { type ProxyTarget } from './lease-ports.js';

export type HttpMethod = 'GET' | 'POST' | 'HEAD' | 'PUT' | 'PATCH' | 'DELETE';

export type RedirectMode = 'follow' | 'manual' | 'error';

export interface HttpRequest {
  url: string;
  method?: HttpMethod | undefined;
  headers?: Readonly<Record<string, string>> | undefined;
  body?: string | undefined;
  /** Overrides the client default. */
  timeoutMs?: number | undefined;
  redirect?: RedirectMode | undefined;
  /** Raw `Cookie` header value, normally supplied from a session lease. */
  cookie?: string | undefined;
  /** Route this request through a proxy. `null`/omitted means direct. */
  proxy?: ProxyTarget | null | undefined;
  signal?: AbortSignal | undefined;
}

export interface HttpResponse {
  /** Final URL after redirects. This is how short links get resolved later. */
  url: string;
  status: number;
  statusText: string;
  headers: Readonly<Record<string, string>>;
  body: string;
  redirected: boolean;
  durationMs: number;
}

/**
 * Transport port. Platform scrapers depend on this interface only, never on a
 * concrete client, so they can be tested with canned responses.
 *
 * Non-2xx responses are RETURNED, not thrown — only the platform layer knows
 * whether a given status means `not_found`, `private` or `rate_limited`.
 * Transport-level problems (DNS, connection reset, timeout) throw `HttpError`.
 */
export interface HttpClient {
  request(request: HttpRequest): Promise<HttpResponse>;
}

export class HttpError extends ScrapeError {
  readonly httpStatus: number | null;

  constructor(options: {
    message: string;
    code?: 'timeout' | 'network_error' | 'http_error' | 'proxy_error' | 'config_error';
    httpStatus?: number | null;
    cause?: unknown;
    causeCode?: string | undefined;
  }) {
    super({
      code: options.code ?? 'network_error',
      message: options.message,
      cause: options.cause,
      causeCode: options.causeCode,
    });
    this.name = 'HttpError';
    this.httpStatus = options.httpStatus ?? null;
  }
}

export function isSuccessfulStatus(status: number): boolean {
  return status >= 200 && status < 300;
}
