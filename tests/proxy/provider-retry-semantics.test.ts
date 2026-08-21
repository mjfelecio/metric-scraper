import { describe, expect, it } from 'vitest';

import { nullLogger } from '../../src/core/logging/logger.js';
import { MetricsCollector } from '../../src/core/metrics/metrics-collector.js';
import { type InputRecord } from '../../src/core/models/input.js';
import { scrapeFailure, scrapeSuccess } from '../../src/core/models/scrape-result.js';
import { EMPTY_VIDEO_DATA } from '../../src/core/models/snapshot.js';
import { MemorySnapshotSink } from '../../src/core/output/snapshot-sink.js';
import { RetryPolicy } from '../../src/core/retry/retry-policy.js';
import { ScrapeRunner } from '../../src/core/runner/scrape-runner.js';
import { type HttpClient } from '../../src/core/scraper/http-port.js';
import { type ProxyTarget } from '../../src/core/scraper/lease-ports.js';
import { type ProxyProvider } from '../../src/core/scraper/provider-ports.js';
import { createScraperRegistry, type Scraper } from '../../src/core/scraper/scraper.js';
import { InMemoryProxyPool } from '../../src/infrastructure/proxy/in-memory-proxy-pool.js';
import { buildProxyTarget } from '../../src/infrastructure/proxy/proxy-config.js';
import { RotatingResidentialProxyProvider } from '../../src/infrastructure/proxy/rotating-residential-proxy-provider.js';
import { StaticProxyProvider } from '../../src/infrastructure/proxy/static-proxy-provider.js';
import { NullSessionPool } from '../../src/infrastructure/session/in-memory-session-pool.js';

const unusedHttp: HttpClient = {
  request: () => Promise.reject(new Error('the HTTP client should not be used by these fakes')),
};

function staticTarget(name: string): ProxyTarget {
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
    platform: 'tiktok' as const,
    position: index + 1,
  }));
}

function runnerWith(provider: ProxyProvider, scraper: Scraper, maxAttempts: number): ScrapeRunner {
  return new ScrapeRunner({
    scrapers: createScraperRegistry([scraper]),
    http: unusedHttp,
    proxyProvider: provider,
    sessionPool: new NullSessionPool(),
    sink: new MemorySnapshotSink(),
    metrics: new MetricsCollector(),
    retryPolicy: new RetryPolicy({ maxAttempts, jitter: false }),
    logger: nullLogger,
    config: {
      concurrency: 1,
      targetRpm: 0,
      maxQueueSize: 0,
      attemptTimeoutMsByPlatform: { tiktok: 5_000, instagram: 20_000 },
    },
    sleep: () => Promise.resolve(),
  });
}

/** Counts acquire/release pairs, so nested retry inside a provider would show up. */
function counting(inner: ProxyProvider): ProxyProvider & { acquires: number; releases: number } {
  const wrapper = {
    acquires: 0,
    releases: 0,
    mode: inner.mode,
    acquire: async (context: Parameters<ProxyProvider['acquire']>[0]) => {
      wrapper.acquires += 1;
      return inner.acquire(context);
    },
    release: (...args: Parameters<ProxyProvider['release']>) => {
      wrapper.releases += 1;
      inner.release(...args);
    },
    getStats: () => inner.getStats(),
  };
  return wrapper;
}

const alwaysFails: Scraper = {
  platform: 'tiktok',
  scrape: () =>
    Promise.resolve(
      scrapeFailure('error', { code: 'http_error', message: 'HTTP 503', retryable: true }),
    ),
};

describe('retry semantics through the provider port', () => {
  it('leases exactly once per attempt, with no provider-side retry on top', async () => {
    // The multiplication this guards against: a provider that retried
    // internally would turn a 3-attempt budget into 3×N real requests, and the
    // configured retry policy would stop meaning what it says.
    const provider = counting(
      new RotatingResidentialProxyProvider({
        target: buildProxyTarget({
          protocol: 'http',
          host: 'gate.example.net',
          port: 7000,
          username: 'u',
          password: 'p',
        }),
      }),
    );

    await runnerWith(provider, alwaysFails, 3).run(records(1));

    expect(provider.acquires).toBe(3);
    expect(provider.releases).toBe(3);
  });

  it('never benches the residential gateway across a fully exhausted retry budget', async () => {
    const provider = new RotatingResidentialProxyProvider({
      target: buildProxyTarget({
        protocol: 'http',
        host: 'gate.example.net',
        port: 7000,
        username: 'u',
        password: 'p',
      }),
    });

    const result = await runnerWith(provider, alwaysFails, 3).run(records(4));

    expect(result.summary.proxies.mode).toBe('rotating-residential');
    expect(result.summary.proxies.cooling).toBe(0);
    expect(result.summary.proxies.blocked).toBe(0);
    expect(result.summary.proxies.retired).toBe(0);
    // One row for the gateway, not one per exit IP — those are invisible to us.
    expect(result.summary.proxies.per_proxy).toHaveLength(1);
    expect(result.summary.proxies.per_proxy[0]?.requests).toBe(12);
  });

  it('still benches a static proxy after its configured consecutive failures', async () => {
    // The same workload against the other mode: static health is unchanged, and
    // this is what the residential case is deliberately different from.
    const pool = new InMemoryProxyPool({
      targets: [staticTarget('a')],
      maxConsecutiveFailures: 2,
      cooldownMs: 60_000,
    });

    const result = await runnerWith(new StaticProxyProvider(pool), alwaysFails, 3).run(records(1));

    expect(result.summary.proxies.mode).toBe('static');
    expect(pool.getStats().perProxy[0]?.state).toBe('cooling');
    expect(pool.getStats().cooling).toBe(1);
  });

  it('reports the mode on a successful run of either kind', async () => {
    const ok: Scraper = {
      platform: 'tiktok',
      scrape: () => Promise.resolve(scrapeSuccess(EMPTY_VIDEO_DATA)),
    };
    const residential = new RotatingResidentialProxyProvider({
      target: buildProxyTarget({
        protocol: 'http',
        host: 'gate.example.net',
        port: 7000,
        username: 'u',
        password: 'p',
      }),
    });
    const staticPool = new StaticProxyProvider(
      new InMemoryProxyPool({ targets: [staticTarget('a')], maxConsecutiveFailures: 3 }),
    );

    const first = await runnerWith(residential, ok, 1).run(records(2));
    const second = await runnerWith(staticPool, ok, 1).run(records(2));

    // Same workload, same summary shape, one field apart: that is the whole
    // point of the abstraction.
    expect(first.summary.proxies.mode).toBe('rotating-residential');
    expect(second.summary.proxies.mode).toBe('static');
    expect(first.summary.totals.successes).toBe(second.summary.totals.successes);
  });
});
