import { describe, expect, it } from 'vitest';

import { BandwidthAggregator } from '../../src/core/metrics/bandwidth.js';
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
import { type ProxyPool } from '../../src/core/scraper/pool-ports.js';
import {
  InMemoryProxyPool,
  NullProxyPool,
} from '../../src/infrastructure/proxy/in-memory-proxy-pool.js';
import { StaticProxyProvider } from '../../src/infrastructure/proxy/static-proxy-provider.js';
import { NullSessionPool } from '../../src/infrastructure/session/in-memory-session-pool.js';
import { createDefaultScraperRegistry } from '../../src/platforms/index.js';

const unusedHttp: HttpClient = {
  request: () => Promise.reject(new Error('the HTTP client should not be used by these fakes')),
};

function records(...urls: string[]): InputRecord[] {
  return recordsFor('tiktok', ...urls);
}

function recordsFor(platform: Platform, ...urls: string[]): InputRecord[] {
  return urls.map((url, index) => ({
    raw_url: url,
    url,
    platform,
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
  targetRpm?: number;
  burst?: number;
  maxQueueSize?: number;
  proxyPool?: ProxyPool;
  sink?: MemorySnapshotSink;
  bandwidth?: BandwidthAggregator | null;
  attemptTimeoutMsByPlatform?: Readonly<Record<Platform, number>>;
  createTimeoutSignal?: (delayMs: number) => AbortSignal;
}) {
  const sink = options.sink ?? new MemorySnapshotSink();
  const metrics = new MetricsCollector();
  const runner = new ScrapeRunner({
    scrapers:
      options.scraper === undefined
        ? createDefaultScraperRegistry()
        : createScraperRegistry([options.scraper]),
    http: unusedHttp,
    // Wrapped rather than replaced: these tests exercise the real static pool
    // through the runner, which is what proves the provider port did not change
    // static behaviour.
    proxyProvider: new StaticProxyProvider(options.proxyPool ?? new NullProxyPool()),
    sessionPool: new NullSessionPool(),
    sink,
    metrics,
    bandwidth: options.bandwidth ?? null,
    retryPolicy: new RetryPolicy({ maxAttempts: options.maxAttempts ?? 3, jitter: false }),
    logger: nullLogger,
    config: {
      concurrency: options.concurrency ?? 4,
      targetRpm: options.targetRpm ?? 0,
      ...(options.burst === undefined ? {} : { burst: options.burst }),
      maxQueueSize: options.maxQueueSize ?? 0,
      attemptTimeoutMsByPlatform: options.attemptTimeoutMsByPlatform ?? {
        tiktok: 5_000,
        instagram: 20_000,
      },
    },
    // No real waiting in tests; the backoff schedule is covered by the retry tests.
    sleep: () => Promise.resolve(),
    ...(options.createTimeoutSignal === undefined
      ? {}
      : { createTimeoutSignal: options.createTimeoutSignal }),
  });

  return { runner, sink, metrics };
}

/** A scraper that reports the peak number of concurrent `scrape` calls. */
function concurrencyProbe(durationMs = 10): { scraper: Scraper; peak: () => number } {
  let inFlight = 0;
  let peak = 0;
  const scraper: Scraper = {
    platform: 'tiktok',
    async scrape(): Promise<ScrapeResult> {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, durationMs));
      inFlight -= 1;
      return scrapeSuccess(EMPTY_VIDEO_DATA);
    },
  };
  return { scraper, peak: () => peak };
}

function urls(count: number): InputRecord[] {
  return records(
    ...Array.from({ length: count }, (_, i) => `https://www.tiktok.com/@a/video/${1000 + i}`),
  );
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

  it('reports null bandwidth when no aggregator was wired in', async () => {
    const { runner } = buildRunner({
      scraper: new FakeScraper(() => scrapeSuccess(EMPTY_VIDEO_DATA)),
    });

    const result = await runner.run(records('https://t/1'));

    expect(result.summary.bandwidth).toBeNull();
  });

  it('refreshes the metrics from the bandwidth aggregator before assembling the summary', async () => {
    // R1: buildRunner wires a BandwidthAggregator into BuiltRunner, but nothing
    // ever fed it into MetricsCollector.recordBandwidth — left alone, the
    // summary's bandwidth block would always be null even with measured
    // traffic. The runner must refresh it itself, right before the summary is
    // built, so this is the regression that must never come back.
    const bandwidth = new BandwidthAggregator();
    bandwidth.record({ proxyId: null, host: 'example.com', requestBytes: 100, responseBytes: 900 });
    bandwidth.record({ proxyId: null, host: 'example.com', requestBytes: 100, responseBytes: 900 });

    const { runner } = buildRunner({
      scraper: new FakeScraper(() => scrapeSuccess(EMPTY_VIDEO_DATA)),
      bandwidth,
    });

    const result = await runner.run(records('https://t/1', 'https://t/2'));

    expect(result.summary.bandwidth).not.toBeNull();
    expect(result.summary.bandwidth).toEqual({
      requests: 2,
      request_bytes: 200,
      response_bytes: 1_800,
      total_bytes: 2_000,
      bytes_per_request: 1_000,
    });
  });

  it.each([
    ['tiktok', 15_000],
    ['instagram', 60_000],
  ] as const)('selects the %s attempt timeout', async (platform, expectedTimeoutMs) => {
    const selectedTimeouts: number[] = [];
    const scraper: Scraper = {
      platform,
      scrape: () => Promise.resolve(scrapeSuccess(EMPTY_VIDEO_DATA)),
    };
    const { runner } = buildRunner({
      scraper,
      attemptTimeoutMsByPlatform: { tiktok: 15_000, instagram: 60_000 },
      createTimeoutSignal: (delayMs) => {
        selectedTimeouts.push(delayMs);
        return new AbortController().signal;
      },
    });

    await runner.run(recordsFor(platform, `https://${platform}/1`));

    expect(selectedTimeouts).toEqual([expectedTimeoutMs]);
  });

  it('allows a multi-request Instagram workflow to use one longer attempt budget', async () => {
    const selectedTimeouts: number[] = [];
    let completedRequests = 0;
    const scraper: Scraper = {
      platform: 'instagram',
      async scrape(_url, context) {
        for (let request = 0; request < 8; request += 1) {
          expect(context.signal.aborted).toBe(false);
          await Promise.resolve();
          completedRequests += 1;
        }
        return scrapeSuccess(EMPTY_VIDEO_DATA);
      },
    };
    const { runner, sink } = buildRunner({
      scraper,
      attemptTimeoutMsByPlatform: { tiktok: 15_000, instagram: 60_000 },
      createTimeoutSignal: (delayMs) => {
        selectedTimeouts.push(delayMs);
        return new AbortController().signal;
      },
    });

    await runner.run(recordsFor('instagram', 'https://instagram/1'));

    expect(selectedTimeouts).toEqual([60_000]);
    expect(completedRequests).toBe(8);
    expect(sink.snapshots[0]?.status).toBe('ok');
  });

  it('stops an attempt when its platform deadline aborts', async () => {
    const deadline = new AbortController();
    const scraper: Scraper = {
      platform: 'instagram',
      scrape: (_url, context) =>
        new Promise((resolve) => {
          context.signal.addEventListener(
            'abort',
            () => {
              resolve(
                scrapeFailure('error', {
                  code: 'timeout',
                  message: 'attempt deadline reached',
                  retryable: true,
                }),
              );
            },
            { once: true },
          );
          queueMicrotask(() => deadline.abort());
        }),
    };
    const { runner, sink } = buildRunner({
      scraper,
      maxAttempts: 1,
      createTimeoutSignal: () => deadline.signal,
    });

    const result = await runner.run(recordsFor('instagram', 'https://instagram/1'));

    expect(sink.snapshots[0]?.error).toContain('timeout: attempt deadline reached');
    expect(result.summary.retries.exhausted_requests).toBe(1);
  });

  it('preserves prompt operator cancellation alongside the attempt deadline', async () => {
    const runController = new AbortController();
    let attempts = 0;
    const scraper: Scraper = {
      platform: 'instagram',
      scrape: (_url, context) =>
        new Promise((resolve) => {
          attempts += 1;
          context.signal.addEventListener(
            'abort',
            () => {
              resolve(
                scrapeFailure('error', {
                  code: 'cancelled',
                  message: 'run cancelled',
                  retryable: false,
                }),
              );
            },
            { once: true },
          );
          queueMicrotask(() => runController.abort());
        }),
    };
    const { runner, sink } = buildRunner({
      scraper,
      createTimeoutSignal: () => new AbortController().signal,
    });

    await runner.run(recordsFor('instagram', 'https://instagram/1'), {
      signal: runController.signal,
    });

    expect(attempts).toBe(1);
    expect(sink.snapshots).toHaveLength(1);
    expect(sink.snapshots[0]?.error).toContain('cancelled: run cancelled');
  });
});

describe('ScrapeRunner concurrency', () => {
  it('runs one job at a time when concurrency is 1', async () => {
    const { scraper, peak } = concurrencyProbe();
    const { runner } = buildRunner({ scraper, concurrency: 1 });

    const result = await runner.run(urls(6));

    expect(peak()).toBe(1);
    expect(result.summary.throughput.concurrency.max_observed).toBe(1);
  });

  it('reaches five in flight when concurrency is 5', async () => {
    const { scraper, peak } = concurrencyProbe();
    const { runner } = buildRunner({ scraper, concurrency: 5 });

    const result = await runner.run(urls(20));

    expect(peak()).toBe(5);
    expect(result.summary.throughput.concurrency.max_observed).toBe(5);
    expect(result.summary.throughput.concurrency.saturated).toBe(true);
  });

  it('reaches ten in flight when concurrency is 10', async () => {
    const { scraper, peak } = concurrencyProbe();
    const { runner } = buildRunner({ scraper, concurrency: 10 });

    const result = await runner.run(urls(30));

    expect(peak()).toBe(10);
    expect(result.summary.throughput.concurrency.max_observed).toBe(10);
  });

  // The regression guard. Rate limiting used to be implemented as task-queue
  // pacing with an `intervalCap` of 1, which meant a single running job blocked
  // every other start: a configured concurrency of 10 ran strictly sequentially.
  // Rate limiting must pace how fast jobs START, never how many may overlap.
  it('still reaches full concurrency while a rate limit is active', async () => {
    const { scraper, peak } = concurrencyProbe();
    const { runner } = buildRunner({
      scraper,
      concurrency: 10,
      targetRpm: 60_000,
      burst: 10,
    });

    const result = await runner.run(urls(30));

    expect(peak()).toBeGreaterThan(1);
    expect(peak()).toBe(10);
    expect(result.summary.throughput.concurrency.effective).toBeGreaterThan(1);
  });

  it('reports effective concurrency near 1 when work really is sequential', async () => {
    const { scraper } = concurrencyProbe();
    const { runner } = buildRunner({ scraper, concurrency: 1 });

    const result = await runner.run(urls(8));

    // Sum of latencies ~= wall clock is the signature of a serialized run.
    expect(result.summary.throughput.concurrency.effective).toBeLessThan(1.5);
    expect(result.summary.throughput.concurrency.utilization).toBe(1);
  });

  it('never reports concurrency it did not actually use', async () => {
    // Only two URLs, so a ceiling of 10 can never be reached. The summary must
    // say so rather than echoing the configured number back.
    const { scraper } = concurrencyProbe();
    const { runner } = buildRunner({ scraper, concurrency: 10 });

    const result = await runner.run(urls(2));

    const concurrency = result.summary.throughput.concurrency;
    expect(concurrency.configured).toBe(10);
    expect(concurrency.max_observed).toBeLessThanOrEqual(2);
    expect(concurrency.saturated).toBe(false);
  });

  it('applies backpressure without failing jobs when the queue is bounded', async () => {
    const { scraper } = concurrencyProbe(2);
    const { runner, sink } = buildRunner({
      scraper,
      concurrency: 4,
      maxQueueSize: 5,
    });

    const result = await runner.run(urls(40));

    // Every job still produces a row; a full queue must slow the producer, not
    // drop work or abort the run.
    expect(sink.snapshots).toHaveLength(40);
    expect(result.fatalError).toBeNull();
    expect(result.summary.queue.max_depth).toBeLessThanOrEqual(6);
  });

  it('uses several proxies at once rather than serializing on the pool', async () => {
    const proxyPool = new InMemoryProxyPool({
      targets: ['a', 'b', 'c'].map((name) => ({
        protocol: 'http' as const,
        host: `${name}.example.net`,
        port: 8000,
        username: null,
        password: null,
        url: `http://${name}.example.net:8000`,
      })),
      maxConcurrentPerProxy: 2,
    });
    const { scraper, peak } = concurrencyProbe();
    const { runner } = buildRunner({ scraper, concurrency: 6, proxyPool });

    const result = await runner.run(urls(18));

    // 3 proxies x 2 slots = 6 units of capacity, and all of it should be used.
    expect(peak()).toBe(6);
    expect(result.summary.proxies.per_proxy).toHaveLength(3);
    for (const proxy of result.summary.proxies.per_proxy) {
      expect(proxy.requests).toBeGreaterThan(0);
    }
  });
});
