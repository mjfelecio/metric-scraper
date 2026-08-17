import { describe, expect, it } from 'vitest';

import { MetricsCollector } from '../../src/core/metrics/metrics-collector.js';
import { ScrapeError } from '../../src/core/models/errors.js';
import { type InputRecord } from '../../src/core/models/input.js';
import { type Platform } from '../../src/core/models/platform.js';
import {
  scrapeFailure,
  scrapeSuccess,
  type ScrapeResult,
} from '../../src/core/models/scrape-result.js';
import { EMPTY_VIDEO_DATA } from '../../src/core/models/snapshot.js';
import { nullLogger } from '../../src/core/logging/logger.js';
import { MemorySnapshotSink } from '../../src/core/output/snapshot-sink.js';
import { RetryPolicy } from '../../src/core/retry/retry-policy.js';
import { ScrapeRunner } from '../../src/core/runner/scrape-runner.js';
import { type HttpClient } from '../../src/core/scraper/http-port.js';
import { createScraperRegistry, type Scraper } from '../../src/core/scraper/scraper.js';
import { NullProxyPool } from '../../src/infrastructure/proxy/in-memory-proxy-pool.js';
import { NullSessionPool } from '../../src/infrastructure/session/in-memory-session-pool.js';
import { createDefaultScraperRegistry } from '../../src/platforms/index.js';

const unusedHttp: HttpClient = {
  request: () => Promise.reject(new Error('the HTTP client should not be used by these fakes')),
};

function records(...urls: string[]): InputRecord[] {
  return urls.map((url, index) => ({
    raw_url: url,
    url,
    platform: 'tiktok',
    position: index + 1,
  }));
}

/** A scraper whose behaviour is scripted per attempt. */
class FakeScraper implements Scraper {
  readonly platform: Platform = 'tiktok';
  readonly calls: { url: string; attempt: number }[] = [];

  constructor(private readonly behaviour: (url: string, attempt: number) => ScrapeResult) {}

  scrape(url: string, context: { attempt: number }): Promise<ScrapeResult> {
    this.calls.push({ url, attempt: context.attempt });
    return Promise.resolve(this.behaviour(url, context.attempt));
  }
}

function buildRunner(options: {
  scraper?: Scraper;
  maxAttempts?: number;
  concurrency?: number;
  sink?: MemorySnapshotSink;
}) {
  const sink = options.sink ?? new MemorySnapshotSink();
  const metrics = new MetricsCollector();
  const runner = new ScrapeRunner({
    scrapers:
      options.scraper === undefined
        ? createDefaultScraperRegistry()
        : createScraperRegistry([options.scraper]),
    http: unusedHttp,
    proxyPool: new NullProxyPool(),
    sessionPool: new NullSessionPool(),
    sink,
    metrics,
    retryPolicy: new RetryPolicy({ maxAttempts: options.maxAttempts ?? 3, jitter: false }),
    logger: nullLogger,
    config: {
      concurrency: options.concurrency ?? 4,
      targetRpm: 0,
      maxQueueSize: 0,
      requestTimeoutMs: 5_000,
    },
    // No real waiting in tests; the backoff schedule is covered by the retry tests.
    sleep: () => Promise.resolve(),
  });

  return { runner, sink, metrics };
}

describe('ScrapeRunner', () => {
  it('writes one row per URL and never drops a failure', async () => {
    const scraper = new FakeScraper((url) =>
      url.endsWith('2')
        ? scrapeFailure('not_found', { code: 'not_found', message: 'gone', retryable: false })
        : scrapeSuccess({ ...EMPTY_VIDEO_DATA, views: 10 }),
    );
    const { runner, sink } = buildRunner({ scraper });

    const result = await runner.run(records('https://t/1', 'https://t/2', 'https://t/3'));

    expect(sink.snapshots).toHaveLength(3);
    expect(result.summary.totals.requests).toBe(3);
    expect(result.summary.totals.successes).toBe(2);
    expect(result.summary.totals.failures).toBe(1);
    expect(result.summary.status_breakdown.not_found).toBe(1);
    expect(result.fatalError).toBeNull();
  });

  it('records a thrown error as a row rather than losing the job', async () => {
    const scraper: Scraper = {
      platform: 'tiktok',
      scrape: () => Promise.reject(new ScrapeError({ code: 'parse_error', message: 'bad html' })),
    };
    const { runner, sink } = buildRunner({ scraper });

    await runner.run(records('https://t/1'));

    expect(sink.snapshots).toHaveLength(1);
    expect(sink.snapshots[0]?.status).toBe('error');
    expect(sink.snapshots[0]?.error).toBe('parse_error: bad html');
  });

  it('retries a transient failure and reports the eventual success', async () => {
    const scraper = new FakeScraper((_url, attempt) =>
      attempt < 3
        ? scrapeFailure('rate_limited', {
            code: 'rate_limited',
            message: 'slow down',
            retryable: true,
          })
        : scrapeSuccess({ ...EMPTY_VIDEO_DATA, views: 1 }),
    );
    const { runner, sink } = buildRunner({ scraper, maxAttempts: 3 });

    const result = await runner.run(records('https://t/1'));

    expect(scraper.calls).toHaveLength(3);
    expect(sink.snapshots[0]?.status).toBe('ok');
    // One work item, two retries — throughput must not count the retries.
    expect(result.summary.totals.requests).toBe(1);
    expect(result.summary.retries.total_retries).toBe(2);
    expect(result.summary.retries.retried_requests).toBe(1);
    expect(result.summary.retries.exhausted_requests).toBe(0);
  });

  it('stops after the attempt budget and marks the request exhausted', async () => {
    const scraper = new FakeScraper(() =>
      scrapeFailure('error', { code: 'network_error', message: 'reset', retryable: true }),
    );
    const { runner } = buildRunner({ scraper, maxAttempts: 2 });

    const result = await runner.run(records('https://t/1'));

    expect(scraper.calls).toHaveLength(2);
    expect(result.summary.retries.total_retries).toBe(1);
    expect(result.summary.retries.exhausted_requests).toBe(1);
  });

  it('does not retry permanent failures', async () => {
    const scraper = new FakeScraper(() =>
      scrapeFailure('private', { code: 'private', message: 'not public', retryable: false }),
    );
    const { runner } = buildRunner({ scraper, maxAttempts: 5 });

    const result = await runner.run(records('https://t/1'));

    expect(scraper.calls).toHaveLength(1);
    expect(result.summary.retries.total_retries).toBe(0);
    expect(result.summary.status_breakdown.private).toBe(1);
  });

  it('produces a row when no scraper is registered for a platform', async () => {
    const { runner, sink } = buildRunner({
      scraper: {
        platform: 'instagram',
        scrape: () => Promise.resolve(scrapeSuccess(EMPTY_VIDEO_DATA)),
      },
    });

    await runner.run(records('https://t/1'));

    expect(sink.snapshots[0]?.status).toBe('error');
    expect(sink.snapshots[0]?.error).toContain('unsupported_platform');
  });

  it('never exceeds the configured concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    const scraper: Scraper = {
      platform: 'tiktok',
      scrape: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return scrapeSuccess(EMPTY_VIDEO_DATA);
      },
    };
    const { runner } = buildRunner({ scraper, concurrency: 3 });

    const urls = Array.from({ length: 12 }, (_, index) => `https://t/${index}`);
    await runner.run(records(...urls));

    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('surfaces an output failure as a fatal run error', async () => {
    const sink = new MemorySnapshotSink();
    sink.write = () => Promise.reject(new Error('disk full'));

    const { runner } = buildRunner({
      scraper: new FakeScraper(() => scrapeSuccess(EMPTY_VIDEO_DATA)),
      sink,
    });

    const result = await runner.run(records('https://t/1', 'https://t/2'));

    expect(result.fatalError).not.toBeNull();
    expect(result.fatalError?.code).toBe('output_error');
    expect(result.fatalError?.message).toContain('disk full');
  });

  it('carries input rejection counts into the summary', async () => {
    const { runner } = buildRunner({
      scraper: new FakeScraper(() => scrapeSuccess(EMPTY_VIDEO_DATA)),
    });

    const result = await runner.run(records('https://t/1'), {
      counts: { candidates: 5, accepted: 1, rejected: 4 },
    });

    expect(result.summary.input).toEqual({ candidates: 5, accepted: 1, rejected: 4 });
  });
});

describe('placeholder platform scrapers', () => {
  it('flow through the whole pipeline as explicit not_implemented rows', async () => {
    const { runner, sink } = buildRunner({});

    const result = await runner.run([
      { raw_url: 'https://t/1', url: 'https://t/1', platform: 'tiktok', position: 1 },
      { raw_url: 'https://i/1', url: 'https://i/1', platform: 'instagram', position: 2 },
    ]);

    expect(sink.snapshots).toHaveLength(2);
    for (const snapshot of sink.snapshots) {
      expect(snapshot.status).toBe('error');
      expect(snapshot.error).toContain('not_implemented');
      // No fabricated metrics.
      expect(snapshot.views).toBeNull();
      expect(snapshot.likes).toBeNull();
      expect(snapshot.video_id).toBeNull();
    }

    // Not retryable: an unimplemented scraper must not burn the retry budget.
    expect(result.summary.retries.total_retries).toBe(0);
    expect(result.summary.totals.success_rate).toBe(0);
    expect(result.summary.error_breakdown).toEqual({ not_implemented: 2 });
  });
});
