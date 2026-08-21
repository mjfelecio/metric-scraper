import { describe, expect, it } from 'vitest';

import { nullLogger } from '../../src/core/logging/logger.js';
import { MetricsCollector } from '../../src/core/metrics/metrics-collector.js';
import { type ScrapeErrorInfo } from '../../src/core/models/errors.js';
import { type InputRecord } from '../../src/core/models/input.js';
import {
  scrapeFailure,
  scrapeSuccess,
  type ScrapeResult,
} from '../../src/core/models/scrape-result.js';
import { EMPTY_VIDEO_DATA } from '../../src/core/models/snapshot.js';
import { MemorySnapshotSink } from '../../src/core/output/snapshot-sink.js';
import { RetryPolicy } from '../../src/core/retry/retry-policy.js';
import { ScrapeRunner } from '../../src/core/runner/scrape-runner.js';
import { type HttpClient } from '../../src/core/scraper/http-port.js';
import { type ProxyTarget } from '../../src/core/scraper/lease-ports.js';
import { type ProxyHealth } from '../../src/core/scraper/pool-ports.js';
import { createScraperRegistry, type Scraper } from '../../src/core/scraper/scraper.js';
import { InMemoryProxyPool } from '../../src/infrastructure/proxy/in-memory-proxy-pool.js';
import { StaticProxyProvider } from '../../src/infrastructure/proxy/static-proxy-provider.js';
import { NullSessionPool } from '../../src/infrastructure/session/in-memory-session-pool.js';

const unusedHttp: HttpClient = {
  request: () => Promise.reject(new Error('the HTTP client should not be used by these fakes')),
};

function target(name: string): ProxyTarget {
  return {
    protocol: 'http',
    host: `${name}.example.net`,
    port: 8000,
    username: null,
    password: null,
    url: `http://${name}.example.net:8000`,
  };
}

function records(count: number): InputRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    raw_url: `https://www.tiktok.com/@a/video/${1000 + index}`,
    url: `https://www.tiktok.com/@a/video/${1000 + index}`,
    platform: 'tiktok',
    position: index + 1,
  }));
}

function scraperReturning(behaviour: (url: string) => ScrapeResult): Scraper {
  return {
    platform: 'tiktok',
    scrape: (url: string) => Promise.resolve(behaviour(url)),
  };
}

function runnerWith(options: {
  scraper: Scraper;
  proxies: string[];
  maxAttempts?: number;
  concurrency?: number;
  maxConcurrentPerProxy?: number;
  maxConsecutiveFailures?: number;
}): { runner: ScrapeRunner; pool: InMemoryProxyPool } {
  const pool = new InMemoryProxyPool({
    targets: options.proxies.map(target),
    maxConsecutiveFailures: options.maxConsecutiveFailures ?? 3,
    cooldownMs: 60_000,
    ...(options.maxConcurrentPerProxy === undefined
      ? {}
      : { maxConcurrentPerProxy: options.maxConcurrentPerProxy }),
  });
  const runner = new ScrapeRunner({
    scrapers: createScraperRegistry([options.scraper]),
    http: unusedHttp,
    proxyProvider: new StaticProxyProvider(pool),
    sessionPool: new NullSessionPool(),
    sink: new MemorySnapshotSink(),
    metrics: new MetricsCollector(),
    retryPolicy: new RetryPolicy({ maxAttempts: options.maxAttempts ?? 1, jitter: false }),
    logger: nullLogger,
    config: {
      concurrency: options.concurrency ?? 1,
      targetRpm: 0,
      maxQueueSize: 0,
      attemptTimeoutMsByPlatform: { tiktok: 5_000, instagram: 20_000 },
    },
    sleep: () => Promise.resolve(),
  });
  return { runner, pool };
}

/**
 * Runs one URL whose attempt produces `result`, then returns what the pool
 * believes about the proxy and what the summary reported about the same event.
 *
 * The point of returning both is that every case below asserts them together:
 * a divergence between rotation state and reported statistics is the bug, not
 * a detail of either one.
 */
async function reportOne(result: ScrapeResult): Promise<{
  health: ProxyHealth;
  reported: {
    proxy_id: string;
    requests: number;
    successes: number;
    failures: number;
    unsuitable: number;
    blocked: boolean;
  };
}> {
  const { runner, pool } = runnerWith({
    scraper: scraperReturning(() => result),
    proxies: ['a'],
  });
  const run = await runner.run(records(1));
  return {
    health: pool.getStats().perProxy[0]!,
    reported: run.summary.proxies.per_proxy[0]!,
  };
}

function httpError(status: number, retryable: boolean): ScrapeErrorInfo {
  return { code: 'http_error', message: `HTTP ${status}`, retryable };
}

describe('proxy health classification', () => {
  it('credits the proxy for a successful scrape', async () => {
    const { health, reported } = await reportOne(scrapeSuccess(EMPTY_VIDEO_DATA));

    expect(health.successes).toBe(1);
    expect(health.failures).toBe(0);
    expect(health.consecutiveFailures).toBe(0);
    expect(reported).toMatchObject({ requests: 1, successes: 1, failures: 0 });
  });

  it('credits the proxy for not_found, which is a fact about the URL', async () => {
    const { health, reported } = await reportOne(
      scrapeFailure('not_found', { code: 'not_found', message: 'gone', retryable: false }),
    );

    expect(health.successes).toBe(1);
    expect(health.failures).toBe(0);
    expect(reported).toMatchObject({ successes: 1, failures: 0 });
  });

  it('credits the proxy for private, which is also a fact about the URL', async () => {
    const { health, reported } = await reportOne(
      scrapeFailure('private', { code: 'private', message: 'login required', retryable: false }),
    );

    expect(health.successes).toBe(1);
    expect(health.failures).toBe(0);
    expect(reported).toMatchObject({ successes: 1, failures: 0 });
  });

  it('blames the proxy for a retryable HTTP failure', async () => {
    const { health, reported } = await reportOne(scrapeFailure('error', httpError(503, true)));

    expect(health.failures).toBe(1);
    expect(health.consecutiveFailures).toBe(1);
    expect(reported).toMatchObject({ successes: 0, failures: 1 });
  });

  it('blames the proxy for a NON-retryable HTTP failure rather than crediting it', async () => {
    const { health, reported } = await reportOne(scrapeFailure('error', httpError(400, false)));

    // The regression this guards: a 4xx we cannot retry still failed through
    // this exit node, so it must not reset the proxy's failure counter.
    expect(health.successes).toBe(0);
    expect(health.consecutiveFailures).toBe(1);
    expect(reported).toMatchObject({ successes: 0, failures: 1 });
  });

  it('does not reset an accumulated failure count on a non-retryable HTTP error', async () => {
    const results: ScrapeResult[] = [
      scrapeFailure('error', httpError(503, true)),
      scrapeFailure('error', httpError(400, false)),
    ];
    const { runner, pool } = runnerWith({
      scraper: scraperReturning(() => results.shift() ?? scrapeSuccess(EMPTY_VIDEO_DATA)),
      proxies: ['a'],
    });

    await runner.run(records(2));

    expect(pool.getStats().perProxy[0]?.consecutiveFailures).toBe(2);
  });

  it('records a transport failure against the proxy', async () => {
    const { health, reported } = await reportOne(
      scrapeFailure('error', { code: 'network_error', message: 'ECONNRESET', retryable: true }),
    );

    expect(health.failures).toBe(1);
    expect(reported).toMatchObject({ successes: 0, failures: 1 });
  });

  it('marks the proxy blocked when the platform rate limits it', async () => {
    const { health, reported } = await reportOne(
      scrapeFailure('rate_limited', { code: 'rate_limited', message: '429', retryable: true }),
    );

    expect(health.blocked).toBe(true);
    expect(health.cooldownUntil).not.toBeNull();
    expect(reported).toMatchObject({ blocked: true, failures: 1 });
  });

  it('records HTTP 451 as an unsuitable exit node, not as a plain failure', async () => {
    const { health, reported } = await reportOne(
      scrapeFailure('error', {
        code: 'geo_blocked',
        message: 'HTTP 451 for this region',
        retryable: true,
      }),
    );

    expect(health.unsuitable).toBe(1);
    expect(health.successes).toBe(0);
    expect(health.retired).toBe(false);
    expect(reported).toMatchObject({ successes: 0, failures: 1, unsuitable: 1 });
  });

  it('neither credits nor blames the proxy for a parse error', async () => {
    const { health, reported } = await reportOne(
      scrapeFailure('error', { code: 'parse_error', message: 'no hydration', retryable: false }),
    );

    // Our parser or the platform changed; every exit node would have produced
    // it, so benching the pool over it would hide the real fault.
    expect(health.successes).toBe(0);
    expect(health.failures).toBe(0);
    expect(health.consecutiveFailures).toBe(0);
    expect(reported).toMatchObject({ requests: 1, successes: 0, failures: 0 });
  });

  it('reports the same numbers the pool rotated on, for every outcome class', async () => {
    const results: ScrapeResult[] = [
      scrapeSuccess(EMPTY_VIDEO_DATA),
      scrapeFailure('not_found', { code: 'not_found', message: 'gone', retryable: false }),
      scrapeFailure('private', { code: 'private', message: 'login', retryable: false }),
      scrapeFailure('error', httpError(503, true)),
      scrapeFailure('error', httpError(400, false)),
      scrapeFailure('error', { code: 'network_error', message: 'ECONNRESET', retryable: true }),
      scrapeFailure('error', { code: 'geo_blocked', message: '451', retryable: true }),
      scrapeFailure('error', { code: 'parse_error', message: 'unparseable', retryable: false }),
    ];
    const total = results.length;
    const { runner, pool } = runnerWith({
      scraper: scraperReturning(() => results.shift() ?? scrapeSuccess(EMPTY_VIDEO_DATA)),
      proxies: ['a'],
      // High enough that the single proxy survives the whole sequence: this
      // test is about classification, not about when a cooldown fires.
      maxConsecutiveFailures: 10,
    });

    const run = await runner.run(records(total));

    const health = pool.getStats().perProxy[0]!;
    const reported = run.summary.proxies.per_proxy[0]!;
    expect(reported.requests).toBe(health.requests);
    expect(reported.successes).toBe(health.successes);
    expect(reported.failures).toBe(health.failures);
    expect(reported.unsuitable).toBe(health.unsuitable);
    expect(reported.blocked).toBe(health.blocked);
    // 3 healthy uses, 4 blamed (503, 400, network, 451), 1 neutral parse error.
    expect(reported).toMatchObject({ requests: total, successes: 3, failures: 4, unsuitable: 1 });
  });
});

describe('proxy pool convergence', () => {
  it('retires a geo-blocked proxy and finishes the batch on the working ones', async () => {
    const { runner, pool } = runnerWith({
      scraper: {
        platform: 'tiktok',
        scrape: (_url, context) =>
          Promise.resolve(
            context.proxy?.id.includes('blocked.') === true
              ? scrapeFailure('error', {
                  code: 'geo_blocked',
                  message: 'HTTP 451 for this region',
                  retryable: true,
                })
              : scrapeSuccess(EMPTY_VIDEO_DATA),
          ),
      },
      proxies: ['blocked', 'good-a', 'good-b'],
      maxAttempts: 3,
      // Enough pressure that the working proxies are busy, so the run keeps
      // reaching for the geo-blocked one instead of quietly never using it.
      concurrency: 3,
      maxConcurrentPerProxy: 1,
    });

    const run = await runner.run(records(30));

    const stats = pool.getStats();
    const bad = stats.perProxy.find((entry) => entry.id.includes('blocked.'))!;
    expect(bad.retired).toBe(true);
    // Retired after its third 451 rather than taking a share of all 30 jobs.
    expect(bad.requests).toBe(3);
    expect(stats.retired).toBe(1);
    expect(run.summary.proxies.retired).toBe(1);

    // Every URL still lands, because a retry leases a different exit node.
    expect(run.summary.totals.successes).toBe(30);
  });

  it('bounds what a dead proxy absorbs under concurrency', async () => {
    const { runner, pool } = runnerWith({
      scraper: {
        platform: 'tiktok',
        scrape: (_url, context) =>
          Promise.resolve(
            context.proxy?.id.includes('dead.') === true
              ? scrapeFailure('error', {
                  code: 'network_error',
                  message: 'ECONNRESET',
                  retryable: true,
                })
              : scrapeSuccess(EMPTY_VIDEO_DATA),
          ),
      },
      proxies: ['dead', 'good-a', 'good-b'],
      maxAttempts: 2,
      concurrency: 20,
      maxConcurrentPerProxy: 10,
    });

    const run = await runner.run(records(60));

    const dead = pool.getStats().perProxy.find((entry) => entry.id.includes('dead.'))!;
    // The failure threshold, not the concurrency, is what bounds the damage:
    // an unproven proxy is handed one job at a time, and once it has failed it
    // sits behind every proxy that is still working.
    expect(dead.requests).toBeLessThanOrEqual(3);
    expect(run.summary.totals.successes).toBe(60);
  });
});
