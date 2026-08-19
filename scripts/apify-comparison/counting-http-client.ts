import {
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from '../../src/core/scraper/http-port.js';

/**
 * Measures what one scrape actually costs on the wire.
 *
 * A decorator rather than a change to `FetchHttpClient`, because requirement
 * one of this experiment is that production behaviour does not move. The
 * production client neither knows nor cares that it is being measured; delete
 * this file and the pipeline is byte-for-byte what it was.
 *
 * The figure is response-body bytes plus a header estimate, not true socket
 * bytes: TLS framing and compression are invisible from here. It is used to
 * compare orders of magnitude against Apify's `netRxBytes`, and the report says
 * so rather than presenting it as a measured transfer.
 */
export class CountingHttpClient implements HttpClient {
  private readonly inner: HttpClient;
  private requests = 0;
  private bytes = 0;

  constructor(inner: HttpClient) {
    this.inner = inner;
  }

  async request(request: HttpRequest): Promise<HttpResponse> {
    this.requests += 1;
    const response = await this.inner.request(request);
    this.bytes += estimateResponseBytes(response);
    return response;
  }

  /** Totals since the last `reset`, so a caller can attribute them per URL. */
  snapshot(): { requests: number; bytes: number } {
    return { requests: this.requests, bytes: this.bytes };
  }

  reset(): void {
    this.requests = 0;
    this.bytes = 0;
  }
}

export function estimateResponseBytes(response: HttpResponse): number {
  const headerBytes = Object.entries(response.headers).reduce(
    // `+ 4` for the `: ` and CRLF that each header line carries on the wire.
    (total, [key, value]) => total + Buffer.byteLength(key) + Buffer.byteLength(value) + 4,
    0,
  );
  return Buffer.byteLength(response.body, 'utf8') + headerBytes;
}
