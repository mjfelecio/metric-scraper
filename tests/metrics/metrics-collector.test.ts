import { describe, expect, it } from 'vitest';

import { MetricsCollector } from '../../src/core/metrics/metrics-collector.js';
import { mean, percentile, percentileOfSorted } from '../../src/core/metrics/percentiles.js';

describe('percentiles', () => {
  it('returns null for an empty sample', () => {
    expect(percentile([], 50)).toBeNull();
    expect(mean([])).toBeNull();
  });

  it('uses nearest rank', () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentileOfSorted(values, 50)).toBe(50);
    expect(percentileOfSorted(values, 95)).toBe(100);
    expect(percentileOfSorted(values, 100)).toBe(100);
    expect(percentileOfSorted(values, 10)).toBe(10);
  });

  it('handles a single sample', () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
  });

  it('sorts before computing', () => {
    expect(percentile([100, 10, 50], 50)).toBe(50);
  });
});

describe('MetricsCollector', () => {
  function collectorAt(times: number[]): MetricsCollector {
    let index = 0;
    return new MetricsCollector({ now: () => times[Math.min(index++, times.length - 1)] ?? 0 });
  }

  it('starts empty', () => {
    const view = new MetricsCollector().view();
    expect(view.totalRequests).toBe(0);
    expect(view.successRate).toBe(0);
    expect(view.throughputPerMinute).toBe(0);
    expect(view.latency.p50Ms).toBeNull();
  });

  it('counts successes, failures and statuses', () => {
    const metrics = new MetricsCollector();
    metrics.start();
    metrics.recordResult({
      status: 'ok',
      latencyMs: 100,
      retries: 0,
      exhausted: false,
      errorCode: null,
    });
    metrics.recordResult({
      status: 'not_found',
      latencyMs: 50,
      retries: 0,
      exhausted: false,
      errorCode: 'not_found',
    });
    metrics.recordResult({
      status: 'error',
      latencyMs: 200,
      retries: 2,
      exhausted: true,
      errorCode: 'network_error',
    });

    const view = metrics.view();
    expect(view.totalRequests).toBe(3);
    expect(view.successfulRequests).toBe(1);
    expect(view.failedRequests).toBe(2);
    expect(view.successRate).toBeCloseTo(1 / 3);
    expect(view.statusCounts.ok).toBe(1);
    expect(view.statusCounts.not_found).toBe(1);
    expect(view.statusCounts.error).toBe(1);
    expect(view.statusCounts.private).toBe(0);
    expect(view.errorCounts).toEqual({ not_found: 1, network_error: 1 });
  });

  it('keeps retries out of the request count', () => {
    const metrics = new MetricsCollector();
    metrics.start();
    metrics.recordRetry();
    metrics.recordRetry();
    metrics.recordRetry();
    metrics.recordResult({
      status: 'error',
      latencyMs: 10,
      retries: 3,
      exhausted: true,
      errorCode: 'timeout',
    });

    const view = metrics.view();
    expect(view.totalRequests).toBe(1);
    expect(view.totalRetries).toBe(3);
    expect(view.retriedRequests).toBe(1);
    expect(view.exhaustedRequests).toBe(1);
  });

  it('computes latency percentiles across recorded requests', () => {
    const metrics = new MetricsCollector();
    metrics.start();
    for (const latency of [10, 20, 30, 40, 50, 60, 70, 80, 90, 1000]) {
      metrics.recordResult({
        status: 'ok',
        latencyMs: latency,
        retries: 0,
        exhausted: false,
        errorCode: null,
      });
    }

    const view = metrics.view();
    expect(view.latency.count).toBe(10);
    expect(view.latency.p50Ms).toBe(50);
    expect(view.latency.p95Ms).toBe(1000);
    expect(view.latency.maxMs).toBe(1000);
    expect(view.latency.meanMs).toBeCloseTo(145);
  });

  it('derives throughput from elapsed time', () => {
    // start() at 0, finish() at 30_000, view() reads the frozen elapsed time.
    const metrics = collectorAt([0, 30_000, 30_000]);
    metrics.start();
    for (let i = 0; i < 10; i += 1) {
      metrics.recordResult({
        status: 'ok',
        latencyMs: 1,
        retries: 0,
        exhausted: false,
        errorCode: null,
      });
    }
    metrics.finish();

    const view = metrics.view();
    expect(view.elapsedMs).toBe(30_000);
    expect(view.throughputPerMinute).toBeCloseTo(20);
  });

  it('tracks per-proxy usage and failures', () => {
    const metrics = new MetricsCollector();
    metrics.start();
    metrics.recordProxyOutcome('http://a.example:8000', 'success');
    metrics.recordProxyOutcome('http://a.example:8000', 'failure');
    metrics.recordProxyOutcome('http://b.example:8000', 'blocked');

    const view = metrics.view();
    expect(view.proxyUsage).toHaveLength(2);
    expect(view.proxyUsage[0]).toMatchObject({
      proxyId: 'http://a.example:8000',
      requests: 2,
      successes: 1,
      failures: 1,
      blocked: false,
    });
    expect(view.proxyUsage[1]).toMatchObject({ blocked: true, failures: 1 });
    expect(view.proxyFailures).toBe(2);
  });

  it('splits per-proxy outcomes by platform and error code', () => {
    const metrics = new MetricsCollector();
    metrics.start();
    metrics.recordProxyOutcome('http://a.example:8000', 'success', { platform: 'tiktok' });
    metrics.recordProxyOutcome('http://a.example:8000', 'failure', {
      platform: 'instagram',
      errorCode: 'http_error',
    });
    metrics.recordProxyOutcome('http://a.example:8000', 'failure', {
      platform: 'instagram',
      errorCode: 'http_error',
    });
    // Neutral outcomes blame nobody, but the reason is still worth counting:
    // parse errors spread across a healthy pool are the evidence that the
    // proxies are not the problem.
    metrics.recordProxyOutcome('http://a.example:8000', 'neutral', {
      platform: 'tiktok',
      errorCode: 'parse_error',
    });

    const usage = metrics.view().proxyUsage[0]!;
    expect(usage.byPlatform).toEqual({
      tiktok: { requests: 2, failures: 0 },
      instagram: { requests: 2, failures: 2 },
    });
    expect(usage.byErrorCode).toEqual({ http_error: 2, parse_error: 1 });
  });

  it('hands out a copy, so a view cannot be mutated into the collector', () => {
    const metrics = new MetricsCollector();
    metrics.start();
    metrics.recordProxyOutcome('http://a.example:8000', 'failure', {
      platform: 'tiktok',
      errorCode: 'timeout',
    });

    const first = metrics.view().proxyUsage[0]!;
    first.byErrorCode['timeout'] = 99;
    first.byPlatform.tiktok = { requests: 99, failures: 99 };

    expect(metrics.view().proxyUsage[0]?.byErrorCode).toEqual({ timeout: 1 });
    expect(metrics.view().proxyUsage[0]?.byPlatform).toEqual({
      tiktok: { requests: 1, failures: 1 },
    });
  });
});

describe('MetricsCollector bandwidth', () => {
  it('reports null bandwidth when nothing was measured', () => {
    expect(new MetricsCollector().view().bandwidth).toBeNull();
  });

  it('exposes the recorded bandwidth view', () => {
    const collector = new MetricsCollector();
    collector.recordBandwidth({
      requests: 2,
      requestBytes: 200,
      responseBytes: 2_800,
      totalBytes: 3_000,
      bytesPerRequest: 1_500,
      perProxy: [
        {
          proxyId: 'p1',
          requests: 2,
          requestBytes: 200,
          responseBytes: 2_800,
          totalBytes: 3_000,
        },
      ],
    });

    const view = collector.view();
    expect(view.bandwidth?.totalBytes).toBe(3_000);
    expect(view.bandwidth?.bytesPerRequest).toBe(1_500);
    expect(view.bandwidth?.perProxy[0]?.proxyId).toBe('p1');
  });

  it('joins measured bytes onto the matching proxy row, leaving others null', () => {
    const collector = new MetricsCollector();
    collector.start();
    collector.recordProxyOutcome('p1', 'success');
    collector.recordProxyOutcome('p2', 'success');
    collector.recordBandwidth({
      requests: 1,
      requestBytes: 100,
      responseBytes: 900,
      totalBytes: 1_000,
      bytesPerRequest: 1_000,
      perProxy: [
        { proxyId: 'p1', requests: 1, requestBytes: 100, responseBytes: 900, totalBytes: 1_000 },
      ],
    });

    const usage = collector.view().proxyUsage;
    const p1 = usage.find((entry) => entry.proxyId === 'p1');
    const p2 = usage.find((entry) => entry.proxyId === 'p2');
    expect(p1?.requestBytes).toBe(100);
    expect(p1?.responseBytes).toBe(900);
    // p2 was never seen by the aggregator: null, not 0.
    expect(p2?.requestBytes).toBeNull();
    expect(p2?.responseBytes).toBeNull();
  });
});
