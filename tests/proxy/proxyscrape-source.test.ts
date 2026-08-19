import { describe, expect, it } from 'vitest';

import { type HttpClient, type HttpRequest, type HttpResponse } from '../../src/core/scraper/http-port.js';
import { ProxyScrapeSource } from '../../src/infrastructure/proxy/proxyscrape-source.js';

const URL = 'https://example.invalid/proxies?format=text';

function client(response: Partial<HttpResponse>): { http: HttpClient; seen: HttpRequest[] } {
  const seen: HttpRequest[] = [];
  return {
    seen,
    http: {
      request(request) {
        seen.push(request);
        return Promise.resolve({
          url: request.url,
          status: 200,
          statusText: 'OK',
          headers: {},
          body: '',
          redirected: false,
          durationMs: 1,
          ...response,
        });
      },
    },
  };
}

describe('ProxyScrapeSource', () => {
  it('fetches the configured endpoint and parses the text list', async () => {
    const { http, seen } = client({ body: 'http://1.2.3.4:8080\nhttp://5.6.7.8:80\n' });
    const source = new ProxyScrapeSource({ url: URL, http });

    const result = await source.fetch();

    expect(result.targets).toHaveLength(2);
    expect(seen[0]?.url).toBe(URL);
    // Never through the pool: fetching the proxy list through a proxy we are
    // not yet sure works would make an empty pool unrecoverable.
    expect(seen[0]?.proxy ?? null).toBeNull();
  });

  it('reports rate limiting distinctly so the caller can back off on its own schedule', async () => {
    const { http } = client({ status: 429, statusText: 'Too Many Requests' });
    const source = new ProxyScrapeSource({ url: URL, http });

    await expect(source.fetch()).rejects.toThrow(/HTTP 429/);
  });

  it('treats any other HTTP error as a failed refresh', async () => {
    const { http } = client({ status: 503, statusText: 'Service Unavailable' });
    const source = new ProxyScrapeSource({ url: URL, http });

    await expect(source.fetch()).rejects.toThrow(/HTTP 503/);
  });

  it('rejects an empty list rather than reporting zero usable candidates', async () => {
    const { http } = client({ body: '   \n\n' });
    const source = new ProxyScrapeSource({ url: URL, http });

    await expect(source.fetch()).rejects.toThrow(/empty list/);
  });

  it('rejects a response that parses to nothing usable', async () => {
    // What an HTML error page or a captcha interstitial looks like from here.
    const { http } = client({ body: '<html><body>blocked</body></html>' });
    const source = new ProxyScrapeSource({ url: URL, http });

    await expect(source.fetch()).rejects.toThrow(/none of them usable/);
  });

  it('counts malformed and duplicate entries without failing', async () => {
    const { http } = client({
      body: ['http://1.2.3.4:8080', 'junk', 'http://1.2.3.4:8080', 'http://5.6.7.8:3128'].join('\n'),
    });
    const source = new ProxyScrapeSource({ url: URL, http });

    const result = await source.fetch();

    expect(result.targets).toHaveLength(2);
    expect(result.malformed).toBe(1);
    expect(result.duplicates).toBe(1);
  });
});
