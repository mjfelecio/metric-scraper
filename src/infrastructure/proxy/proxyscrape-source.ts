import { type Logger, nullLogger } from '../../core/logging/logger.js';
import { ScrapeError } from '../../core/models/errors.js';
import { type HttpClient } from '../../core/scraper/http-port.js';
import {
  type ProxySource,
  type ProxySourceFetchResult,
} from '../../core/scraper/proxy-source-ports.js';

import { parseProxySourceText } from './parse-proxy-source.js';

export interface ProxyScrapeSourceOptions {
  /** Full endpoint URL. Never hard-coded here — always supplied by config. */
  url: string;
  http: HttpClient;
  /** Short name that becomes `ProxyHealth.source`. */
  name?: string | undefined;
  timeoutMs?: number | undefined;
  logger?: Logger | undefined;
}

/**
 * A candidate supply backed by a plain-text proxy list endpoint.
 *
 * The text format carries exactly what the pool needs — protocol, host, port —
 * so the richer JSON variant of the same API is deliberately not used: it would
 * add parsing surface and a schema to keep in step for metadata nothing here
 * consumes.
 *
 * The request goes out directly, never through the pool: routing the fetch for
 * our proxy list through a proxy we are not yet sure works would make an empty
 * pool unrecoverable.
 */
export class ProxyScrapeSource implements ProxySource {
  readonly name: string;
  private readonly url: string;
  private readonly http: HttpClient;
  private readonly timeoutMs: number | undefined;
  private readonly logger: Logger;

  constructor(options: ProxyScrapeSourceOptions) {
    this.url = options.url;
    this.http = options.http;
    this.name = options.name ?? 'proxyscrape';
    this.timeoutMs = options.timeoutMs;
    this.logger = options.logger ?? nullLogger;
  }

  async fetch(signal?: AbortSignal): Promise<ProxySourceFetchResult> {
    const response = await this.http.request({
      url: this.url,
      method: 'GET',
      headers: { accept: 'text/plain' },
      ...(this.timeoutMs === undefined ? {} : { timeoutMs: this.timeoutMs }),
      ...(signal === undefined ? {} : { signal }),
    });

    if (response.status < 200 || response.status >= 300) {
      // 429 included: the caller backs off on its refresh interval rather than
      // retrying here, because a stale candidate list is not an emergency.
      throw new ScrapeError({
        code: response.status === 429 ? 'rate_limited' : 'http_error',
        message: `proxy source returned HTTP ${response.status} ${response.statusText}`.trim(),
        retryable: true,
      });
    }

    const result = parseProxySourceText(response.body);
    if (result.targets.length === 0) {
      throw new ScrapeError({
        code: 'network_error',
        message:
          result.total === 0
            ? 'proxy source returned an empty list'
            : `proxy source returned ${result.total} entries, none of them usable`,
        retryable: true,
      });
    }

    this.logger.info(
      {
        source: this.name,
        usable: result.targets.length,
        total: result.total,
        malformed: result.malformed,
        duplicates: result.duplicates,
      },
      'fetched proxy candidates',
    );
    return result;
  }
}
