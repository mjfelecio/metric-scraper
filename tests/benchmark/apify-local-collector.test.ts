import { describe, expect, it, vi } from 'vitest';

import {
  CountingHttpClient,
  estimateResponseBytes,
} from '../../scripts/apify-comparison/counting-http-client.js';
import { collectLocally } from '../../scripts/apify-comparison/local-collector.js';
import { type BenchmarkTarget } from '../../scripts/apify-comparison/types.js';
import { ScrapeError } from '../../src/core/models/errors.js';
import { scrapeFailure, scrapeSuccess } from '../../src/core/models/scrape-result.js';
import { EMPTY_VIDEO_DATA } from '../../src/core/models/snapshot.js';
import { type HttpClient, type HttpResponse } from '../../src/core/scraper/http-port.js';
import { type Scraper } from '../../src/core/scraper/scraper.js';

const TARGETS: readonly BenchmarkTarget[] = [
  {
    videoId: '111',
    url: 'https://www.tiktok.com/@a/video/111',
    rawUrls: [],
    kind: 'video',
    handle: 'a',
  },
  {
    videoId: '222',
    url: 'https://www.tiktok.com/@b/video/222',
    rawUrls: [],
    kind: 'video',
    handle: 'b',
  },
];

function response(body: string): HttpResponse {
  return {
    url: 'https://www.tiktok.com/embed/v2/111',
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'text/html' },
    body,
    redirected: false,
    durationMs: 3,
  };
}

function http(body = 'x'.repeat(1_000)): CountingHttpClient {
  const inner: HttpClient = { request: () => Promise.resolve(response(body)) };
  return new CountingHttpClient(inner);
}

describe('CountingHttpClient', () => {
  it('counts requests and response bytes, and resets between targets', async () => {
    const client = http('hello');
    await client.request({ url: 'https://example.test' });
    await client.request({ url: 'https://example.test' });

    expect(client.snapshot().requests).toBe(2);
    expect(client.snapshot().bytes).toBeGreaterThan(10);

    client.reset();
    expect(client.snapshot()).toEqual({ requests: 0, bytes: 0 });
  });

  it('passes the request through unchanged', async () => {
    const request = vi.fn<HttpClient['request']>().mockResolvedValue(response('body'));
    const client = new CountingHttpClient({ request });
    const result = await client.request({ url: 'https://example.test', method: 'GET' });

    expect(request).toHaveBeenCalledWith({ url: 'https://example.test', method: 'GET' });
    expect(result.body).toBe('body');
  });

  it('counts body plus header bytes', () => {
    expect(estimateResponseBytes(response('abcd'))).toBe(
      4 + 'content-type'.length + 'text/html'.length + 4,
    );
  });
});

describe('collectLocally', () => {
  it('produces one snapshot per target with per-target bytes and latency', async () => {
    const scraper: Scraper = {
      platform: 'tiktok',
      scrape: async (url, context) => {
        await context.http.request({ url });
        return scrapeSuccess({
          ...EMPTY_VIDEO_DATA,
          video_id: url.split('/').pop() ?? null,
          views: 5,
        });
      },
    };

    const result = await collectLocally(TARGETS, {
      scraper,
      http: http(),
      timeoutMs: 5_000,
    });

    expect(result.snapshots).toHaveLength(2);
    expect(result.observations.map((entry) => entry.videoId)).toEqual(['111', '222']);
    expect(result.observations.every((entry) => entry.ok)).toBe(true);
    expect(result.totalRequests).toBe(2);
    // Each target's bytes are attributed to it, not to the run as a whole.
    expect(result.observations[0]?.responseBytes).toBeGreaterThan(0);
    expect(result.totalBytes).toBe(
      (result.observations[0]?.responseBytes ?? 0) + (result.observations[1]?.responseBytes ?? 0),
    );
  });

  it('records a scraper failure as a row rather than dropping the target', async () => {
    const scraper: Scraper = {
      platform: 'tiktok',
      scrape: () =>
        Promise.resolve(
          scrapeFailure('not_found', {
            code: 'not_found',
            message: 'TikTok video was not found',
            retryable: false,
          }),
        ),
    };

    const result = await collectLocally(TARGETS, { scraper, http: http(), timeoutMs: 5_000 });

    expect(result.observations).toHaveLength(2);
    expect(result.observations[0]?.ok).toBe(false);
    expect(result.observations[0]?.error).toMatch(/not_found/);
    expect(result.snapshots[0]?.status).toBe('not_found');
  });

  it('reports no metrics at all for a failed scrape', async () => {
    const scraper: Scraper = {
      platform: 'tiktok',
      // Salvaged partial data must not become a number in the comparison.
      scrape: () =>
        Promise.resolve(
          scrapeFailure(
            'error',
            { code: 'parse_error', message: 'bad html', retryable: false },
            { video_id: '111', views: 999 },
          ),
        ),
    };

    const result = await collectLocally([TARGETS[0]!], { scraper, http: http(), timeoutMs: 5_000 });
    expect(result.observations[0]?.metrics.views).toBeNull();
  });

  it('turns a thrown error into a failed row and carries on', async () => {
    let calls = 0;
    const scraper: Scraper = {
      platform: 'tiktok',
      scrape: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(new ScrapeError({ code: 'timeout', message: 'request timed out' }));
        }
        return Promise.resolve(scrapeSuccess({ ...EMPTY_VIDEO_DATA, video_id: '222', views: 1 }));
      },
    };

    const result = await collectLocally(TARGETS, { scraper, http: http(), timeoutMs: 5_000 });

    expect(result.observations[0]?.ok).toBe(false);
    expect(result.observations[0]?.error).toMatch(/timeout/);
    // The second target still ran — one failure does not end the experiment.
    expect(result.observations[1]?.ok).toBe(true);
  });

  it('gives the scraper a signal that aborts on the configured timeout', async () => {
    const scraper: Scraper = {
      platform: 'tiktok',
      scrape: (_url, context) =>
        new Promise((resolve) => {
          context.signal.addEventListener('abort', () => {
            resolve(
              scrapeFailure('error', {
                code: 'timeout',
                message: 'aborted by the benchmark deadline',
                retryable: true,
              }),
            );
          });
        }),
    };

    const result = await collectLocally([TARGETS[0]!], {
      scraper,
      http: http(),
      timeoutMs: 1_000,
    });

    expect(result.observations[0]?.ok).toBe(false);
    expect(result.observations[0]?.error).toMatch(/aborted by the benchmark deadline/);
  });
});
