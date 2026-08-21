import { describe, expect, it } from 'vitest';

import { nullLogger } from '../../../src/core/logging/logger.js';
import { BandwidthAggregator } from '../../../src/core/metrics/bandwidth.js';
import { MetricsCollector } from '../../../src/core/metrics/metrics-collector.js';
import { type InputRecord } from '../../../src/core/models/input.js';
import { MemorySnapshotSink } from '../../../src/core/output/snapshot-sink.js';
import { RetryPolicy } from '../../../src/core/retry/retry-policy.js';
import { ScrapeRunner } from '../../../src/core/runner/scrape-runner.js';
import { type ProxyTarget } from '../../../src/core/scraper/lease-ports.js';
import { createScraperRegistry } from '../../../src/core/scraper/scraper.js';
import { createCountingInterceptor } from '../../../src/infrastructure/http/counting-dispatcher.js';
import { FetchHttpClient } from '../../../src/infrastructure/http/fetch-http-client.js';
import { InMemoryProxyPool } from '../../../src/infrastructure/proxy/in-memory-proxy-pool.js';
import { StaticProxyProvider } from '../../../src/infrastructure/proxy/static-proxy-provider.js';
import { NullSessionPool } from '../../../src/infrastructure/session/in-memory-session-pool.js';
import { TikTokScraper } from '../../../src/platforms/tiktok/tiktok-scraper.js';
import {
  createMockDispatcherFactory,
  createSharedMockAgent,
} from '../../../src/stress/upstream/proxy-mock-dispatcher.js';
import {
  computeTikTokRequestLatencyMs,
  registerTikTokMockUpstream,
} from '../../../src/stress/upstream/tiktok-mock-upstream.js';
import { type TikTokWorkloadProfile } from '../../../src/stress/workload/workload-profile.js';
import { tiktokSyntheticUrl } from '../../../src/stress/workload/synthetic-input.js';

const PROXY_TARGET: ProxyTarget = {
  protocol: 'http',
  host: 'mock-proxy-1.local',
  port: 8000,
  username: null,
  password: null,
  url: 'http://mock-proxy-1.local:8000',
};

function buildRunner(profile: TikTokWorkloadProfile, seed: number, maxAttempts = 3) {
  const mockAgent = createSharedMockAgent();
  registerTikTokMockUpstream(mockAgent, profile, seed);
  const bandwidth = new BandwidthAggregator();
  const dispatcherFactory = createMockDispatcherFactory(mockAgent, bandwidth, (opts) =>
    computeTikTokRequestLatencyMs(opts, profile, seed),
  );
  const http = new FetchHttpClient({ defaultTimeoutMs: 5_000, dispatcherFactory });
  const proxyPool = new InMemoryProxyPool({ targets: [PROXY_TARGET] });
  const proxyProvider = new StaticProxyProvider(proxyPool);
  const metrics = new MetricsCollector();
  const sink = new MemorySnapshotSink();

  const runner = new ScrapeRunner({
    scrapers: createScraperRegistry([new TikTokScraper()]),
    http,
    proxyProvider,
    sessionPool: new NullSessionPool(),
    sink,
    metrics,
    bandwidth,
    retryPolicy: new RetryPolicy({ maxAttempts, initialDelayMs: 1, maxDelayMs: 1, jitter: false }),
    logger: nullLogger,
    config: {
      concurrency: 1,
      targetRpm: 0,
      maxQueueSize: 100,
      attemptTimeoutMsByPlatform: { tiktok: 5_000, instagram: 5_000 },
    },
    sleep: () => Promise.resolve(),
  });

  return { runner, metrics, proxyProvider, bandwidth };
}

function record(url: string): InputRecord {
  return { raw_url: url, url, platform: 'tiktok', position: 1 };
}

describe('telemetry cross-check: proxy leases vs platform_http_requests vs bandwidth.requests', () => {
  it('a normal job: 1 proxy lease, 2 logical requests, 2 wire requests -- all equal', async () => {
    const profile: TikTokWorkloadProfile = {
      scenarios: { normal: 1 },
      retryFailFirstN: 1,
      latency: { minMs: 0, maxMs: 0 },
      responseSize: { targetBytes: 5_000 },
    };
    const { runner, metrics, proxyProvider, bandwidth } = buildRunner(profile, 1);

    await runner.run([record(tiktokSyntheticUrl(100))]);

    expect(proxyProvider.getStats().perProxy[0]?.requests).toBe(1);
    expect(metrics.view().platformHttpRequests).toBe(2);
    expect(bandwidth.view().requests).toBe(2);
  });

  it('a retried job: proxy leases (per attempt) diverge from logical/wire requests (summed across attempts)', async () => {
    const profile: TikTokWorkloadProfile = {
      scenarios: { retry_then_success: 1 },
      retryFailFirstN: 1,
      latency: { minMs: 0, maxMs: 0 },
      responseSize: { targetBytes: 5_000 },
    };
    const { runner, metrics, proxyProvider, bandwidth } = buildRunner(profile, 2);

    const result = await runner.run([record(tiktokSyntheticUrl(101))]);

    // Attempt 1: embed fails (500) -- 1 logical call. Attempt 2: embed+player
    // succeed -- 2 logical calls. 3 total, across 2 attempts (2 proxy leases).
    expect(result.summary.retries.total_retries).toBe(1);
    expect(proxyProvider.getStats().perProxy[0]?.requests).toBe(2);
    expect(metrics.view().platformHttpRequests).toBe(3);
    expect(bandwidth.view().requests).toBe(3);
    // The headline point: proxy leases and logical/wire requests are NOT the
    // same number, and must not be conflated when reading a stress report.
    expect(proxyProvider.getStats().perProxy[0]?.requests).not.toBe(
      metrics.view().platformHttpRequests,
    );
  });

  it('a followed redirect makes wire-level bandwidth requests exceed logical HttpClient calls', async () => {
    // A minimal, scraper-independent demonstration: MockAgent replies to one
    // path with a 302 to a second path, and undici's fetch (redirect:
    // 'follow', the mode every TikTok/Instagram GET in this codebase uses)
    // chases it as a second wire-level dispatch -- one logical
    // `HttpClient.request()` call, two counting-interceptor firings.
    const mockAgent = createSharedMockAgent();
    const pool = mockAgent.get('https://redirect.example.test');
    pool
      .intercept({ path: '/start', method: 'GET' })
      .reply(302, '', { headers: { location: '/final' } })
      .persist();
    pool.intercept({ path: '/final', method: 'GET' }).reply(200, 'landed').persist();

    const bandwidth = new BandwidthAggregator();
    // Reuse the same counting interceptor production wires in, tagged direct (no proxy).
    const dispatcher = mockAgent.compose(
      createCountingInterceptor({ sink: bandwidth, proxyId: null }),
    );
    const http = new FetchHttpClient({ defaultTimeoutMs: 5_000, defaultDispatcher: dispatcher });

    const response = await http.request({
      url: 'https://redirect.example.test/start',
      method: 'GET',
      redirect: 'follow',
    });

    expect(response.status).toBe(200);
    expect(response.redirected).toBe(true);
    // One logical call produced two wire-level dispatches.
    expect(bandwidth.view().requests).toBe(2);
  });
});
