import { describe, expect, it } from 'vitest';

import { MetricsCollector } from '../../src/core/metrics/metrics-collector.js';
import { RunSummarySchema } from '../../src/core/models/run-summary.js';
import { buildRunSummary } from '../../src/core/runner/build-summary.js';
import { formatRunSummary } from '../../src/core/runner/format-summary.js';
import { NullProxyPool } from '../../src/infrastructure/proxy/in-memory-proxy-pool.js';
import { NullSessionPool } from '../../src/infrastructure/session/in-memory-session-pool.js';

function summaryFixture() {
  const metrics = new MetricsCollector();
  metrics.start();

  for (const latency of [100, 200, 300, 400, 500]) {
    metrics.recordResult({
      status: 'ok',
      latencyMs: latency,
      retries: 0,
      exhausted: false,
      errorCode: null,
    });
  }
  metrics.recordRetry();
  metrics.recordRetry();
  metrics.recordResult({
    status: 'rate_limited',
    latencyMs: 900,
    retries: 2,
    exhausted: true,
    errorCode: 'rate_limited',
  });
  metrics.finish();

  return buildRunSummary({
    runId: 'test-run',
    platform: 'tiktok',
    startedAt: new Date('2026-08-17T10:00:00.000Z'),
    finishedAt: new Date('2026-08-17T10:00:30.000Z'),
    counts: { candidates: 8, accepted: 6, rejected: 2 },
    metrics: metrics.view(),
    proxyStats: new NullProxyPool().getStats(),
    sessionStats: new NullSessionPool().getStats(),
    concurrency: 10,
    targetRpm: 500,
    snapshotsPath: '/tmp/run.jsonl',
    summaryPath: '/tmp/run.summary.json',
    rowsWritten: 6,
  });
}

describe('buildRunSummary', () => {
  it('produces a schema-valid summary', () => {
    expect(RunSummarySchema.safeParse(summaryFixture()).success).toBe(true);
  });

  it('reports totals and success rate', () => {
    const summary = summaryFixture();
    expect(summary.totals.requests).toBe(6);
    expect(summary.totals.successes).toBe(5);
    expect(summary.totals.failures).toBe(1);
    expect(summary.totals.success_rate).toBeCloseTo(5 / 6);
  });

  it('derives throughput from wall-clock duration, not from retries', () => {
    const summary = summaryFixture();
    expect(summary.duration_ms).toBe(30_000);
    // 6 requests in 30s = 12 per minute; the 2 retries must not inflate this.
    expect(summary.throughput.requests_per_minute).toBeCloseTo(12);
    expect(summary.retries.total_retries).toBe(2);
    expect(summary.retries.retried_requests).toBe(1);
    expect(summary.retries.exhausted_requests).toBe(1);
  });

  it('reports latency percentiles', () => {
    const summary = summaryFixture();
    expect(summary.latency.count).toBe(6);
    expect(summary.latency.p50_ms).toBe(300);
    expect(summary.latency.p95_ms).toBe(900);
    expect(summary.latency.max_ms).toBe(900);
  });

  it('breaks results down by status and error code', () => {
    const summary = summaryFixture();
    expect(summary.status_breakdown.ok).toBe(5);
    expect(summary.status_breakdown.rate_limited).toBe(1);
    expect(summary.error_breakdown).toEqual({ rate_limited: 1 });
  });

  it('records rejected input alongside accepted input', () => {
    const summary = summaryFixture();
    expect(summary.input).toEqual({ candidates: 8, accepted: 6, rejected: 2 });
  });

  it('handles a run with no requests without dividing by zero', () => {
    const metrics = new MetricsCollector();
    metrics.start();
    metrics.finish();

    const summary = buildRunSummary({
      runId: 'empty',
      platform: null,
      startedAt: new Date('2026-08-17T10:00:00.000Z'),
      finishedAt: new Date('2026-08-17T10:00:00.000Z'),
      counts: { candidates: 0, accepted: 0, rejected: 0 },
      metrics: metrics.view(),
      proxyStats: new NullProxyPool().getStats(),
      sessionStats: new NullSessionPool().getStats(),
      concurrency: 1,
      targetRpm: 0,
      snapshotsPath: null,
      summaryPath: null,
      rowsWritten: 0,
    });

    expect(summary.totals.success_rate).toBe(0);
    expect(summary.throughput.requests_per_minute).toBe(0);
    expect(summary.latency.p50_ms).toBeNull();
    expect(RunSummarySchema.safeParse(summary).success).toBe(true);
  });
});

describe('formatRunSummary', () => {
  it('renders the human-readable projection of the same numbers', () => {
    const text = formatRunSummary(summaryFixture());
    expect(text).toContain('Total requests');
    expect(text).toContain('83.3%');
    expect(text).toContain('Latency p95');
    expect(text).toContain('none configured (direct connection)');
    expect(text).toContain('/tmp/run.jsonl');
  });
});

describe('concurrency reporting', () => {
  function summaryWith(options: {
    configured: number;
    peakInFlight: number;
    peakQueueDepth: number;
  }) {
    const metrics = new MetricsCollector();
    metrics.start();
    metrics.configureConcurrency(options.configured);
    metrics.recordQueueStats({
      peakInFlight: options.peakInFlight,
      peakQueueDepth: options.peakQueueDepth,
      waitSamples: [1, 2, 3],
    });
    for (const latency of [1_000, 1_000, 1_000]) {
      metrics.recordResult({
        status: 'ok',
        latencyMs: latency,
        retries: 0,
        exhausted: false,
        errorCode: null,
      });
    }
    metrics.finish();

    return buildRunSummary({
      runId: 'test-run',
      platform: 'tiktok',
      startedAt: new Date('2026-08-17T10:00:00.000Z'),
      finishedAt: new Date('2026-08-17T10:00:03.000Z'),
      counts: { candidates: 3, accepted: 3, rejected: 0 },
      metrics: metrics.view(),
      proxyStats: new NullProxyPool().getStats(),
      sessionStats: new NullSessionPool().getStats(),
      concurrency: options.configured,
      targetRpm: 500,
      snapshotsPath: null,
      summaryPath: null,
      rowsWritten: 3,
    });
  }

  it('reports what actually ran, not what was configured', () => {
    const summary = summaryWith({ configured: 10, peakInFlight: 1, peakQueueDepth: 9 });

    expect(summary.throughput.concurrency.configured).toBe(10);
    expect(summary.throughput.concurrency.max_observed).toBe(1);
    expect(summary.throughput.concurrency.saturated).toBe(false);
    expect(summary.throughput.concurrency.utilization).toBeCloseTo(0.1);
  });

  it('scores a fully serialized run at an effective concurrency of one', () => {
    // Three 1s requests across 3s of wall clock: strictly one at a time.
    const summary = summaryWith({ configured: 10, peakInFlight: 1, peakQueueDepth: 9 });
    expect(summary.throughput.concurrency.effective).toBeCloseTo(1);
  });

  it('warns when capacity was available but unused', () => {
    const text = formatRunSummary(summaryWith({ configured: 10, peakInFlight: 1, peakQueueDepth: 9 }));

    // The report must not be able to claim a concurrency it never reached.
    expect(text).toMatch(/Concurrency underused/);
    expect(text).toMatch(/effectively sequential/);
    expect(text).toMatch(/1 observed \/ 10 configured/);
  });

  it('stays quiet when the configured concurrency was actually reached', () => {
    const text = formatRunSummary(summaryWith({ configured: 3, peakInFlight: 3, peakQueueDepth: 2 }));
    expect(text).not.toMatch(/Concurrency underused/);
  });

  it('stays quiet when nothing ever queued, since capacity was never demanded', () => {
    const text = formatRunSummary(summaryWith({ configured: 10, peakInFlight: 2, peakQueueDepth: 0 }));
    expect(text).not.toMatch(/Concurrency underused/);
  });
});
