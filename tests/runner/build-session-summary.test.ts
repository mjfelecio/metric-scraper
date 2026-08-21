import { describe, expect, it } from 'vitest';

import { ThroughputTimeline } from '../../src/core/metrics/throughput-timeline.js';
import { type RunSummary } from '../../src/core/models/run-summary.js';
import { type CycleSummary } from '../../src/core/models/session-summary.js';
import { buildSessionSummary } from '../../src/core/runner/build-session-summary.js';
import { type ProxyHealth } from '../../src/core/scraper/pool-ports.js';
import { type ProxyProviderStats } from '../../src/core/scraper/provider-ports.js';

function runSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    run_id: 'cycle',
    platform: 'tiktok',
    started_at: '2026-08-18T00:00:00.000Z',
    finished_at: '2026-08-18T00:00:30.000Z',
    duration_ms: 30_000,
    input: { candidates: 10, accepted: 10, rejected: 0 },
    totals: {
      requests: 10,
      platform_http_requests: 10,
      successes: 8,
      failures: 2,
      success_rate: 0.8,
    },
    throughput: {
      requests_per_minute: 20,
      target_rpm: 500,
      concurrency: {
        configured: 5,
        max_observed: 5,
        effective: 4.8,
        utilization: 1,
        saturated: true,
      },
    },
    bandwidth: null,
    queue: { max_depth: 5, wait_p50_ms: 10, wait_p95_ms: 20, wait_max_ms: 25 },
    waits: {
      admission_ms: 0,
      http_rate_limit_ms: 0,
      proxy_acquire_ms: 0,
      retry_backoff_ms: 0,
    },
    latency: { count: 10, p50_ms: 100, p95_ms: 200, max_ms: 300, mean_ms: 120 },
    status_breakdown: { ok: 8, not_found: 0, private: 0, rate_limited: 1, error: 1 },
    error_breakdown: { rate_limited: 1, network_error: 1 },
    retries: { total_retries: 4, retried_requests: 3, exhausted_requests: 1 },
    proxies: {
      mode: 'static',
      configured: 0,
      used: 0,
      available: 0,
      untested: 0,
      cooling: 0,
      saturated: 0,
      blocked: 0,
      retired: 0,
      total_in_flight: 0,
      capacity: null,
      pool_exhausted: 0,
      total_failures: 0,
      source: null,
      per_proxy: [],
    },
    sessions: { configured: 0, used: 0, blocked: 0, total_failures: 0, per_session: [] },
    output: { snapshots_path: null, summary_path: null, rows_written: 10 },
    ...overrides,
  };
}

function cycle(n: number, overrides: Partial<CycleSummary> = {}): CycleSummary {
  return {
    cycle: n,
    scheduled_at: '2026-08-18T00:00:00.000Z',
    started_at: '2026-08-18T00:00:00.000Z',
    finished_at: '2026-08-18T00:00:30.000Z',
    lag_ms: 0,
    overran: false,
    summary: runSummary(),
    error: null,
    ...overrides,
  };
}

function build(options: {
  cycles: CycleSummary[];
  latenciesMs?: number[];
  timeline?: ThroughputTimeline;
  durationMs?: number;
  targetRpm?: number;
  proxyStats?: ProxyProviderStats;
}) {
  const startedAt = new Date('2026-08-18T00:00:00.000Z');
  return buildSessionSummary({
    sessionId: 'session-1',
    platform: 'tiktok',
    startedAt,
    finishedAt: new Date(startedAt.getTime() + (options.durationMs ?? 120_000)),
    counts: { candidates: 10, accepted: 10, rejected: 0 },
    cycles: options.cycles,
    latenciesMs: options.latenciesMs ?? [],
    timeline: options.timeline ?? new ThroughputTimeline({ startedAtMs: 0, now: () => 0 }),
    schedule: {
      intervalMs: 60_000,
      durationMs: null,
      maxCycles: null,
      stopReason: 'max_cycles',
    },
    concurrency: 5,
    targetRpm: options.targetRpm ?? 500,
    stalled: false,
    ...(options.proxyStats === undefined ? {} : { proxyStats: options.proxyStats }),
    snapshotsPath: null,
    summaryPath: null,
    cyclesDir: null,
    rowsWritten: 20,
  });
}

describe('buildSessionSummary', () => {
  it('sums totals, breakdowns and retries across cycles', () => {
    const summary = build({ cycles: [cycle(1), cycle(2)] });

    expect(summary.totals).toEqual({
      requests: 20,
      successes: 16,
      failures: 4,
      success_rate: 0.8,
    });
    expect(summary.status_breakdown.ok).toBe(16);
    expect(summary.status_breakdown.rate_limited).toBe(2);
    expect(summary.error_breakdown).toEqual({ rate_limited: 2, network_error: 2 });
    expect(summary.retries).toEqual({
      total_retries: 8,
      retried_requests: 6,
      exhausted_requests: 2,
    });
  });

  it('separates wall-clock throughput from active throughput', () => {
    // Two 30s cycles inside a 120s session: half the time was idle.
    const summary = build({ cycles: [cycle(1), cycle(2)], durationMs: 120_000 });

    // 20 requests / 120s = 10 per minute.
    expect(summary.throughput.wall_clock_rpm).toBeCloseTo(10);
    // 20 requests / 60s of actual work = 20 per minute.
    expect(summary.throughput.active_rpm).toBeCloseTo(20);
  });

  it('never folds retries into any throughput figure', () => {
    const summary = build({ cycles: [cycle(1), cycle(2)] });

    // 8 retries happened, but throughput counts the 20 work items only.
    expect(summary.retries.total_retries).toBe(8);
    expect(summary.throughput.wall_clock_rpm).toBeCloseTo(10);
    expect(summary.throughput.active_rpm).toBeCloseTo(20);
  });

  it('recomputes latency from raw samples instead of averaging cycle percentiles', () => {
    const summary = build({
      cycles: [cycle(1), cycle(2)],
      latenciesMs: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
    });

    // Nearest-rank over the real samples, so every value is one that was observed.
    expect(summary.latency.count).toBe(10);
    expect(summary.latency.p50_ms).toBe(50);
    expect(summary.latency.p95_ms).toBe(100);
    expect(summary.latency.max_ms).toBe(100);
  });

  it('counts a failed cycle without letting it corrupt the totals', () => {
    const summary = build({
      cycles: [
        cycle(1),
        cycle(2, { summary: null, error: { code: 'unknown', message: 'boom' } }),
        cycle(3),
      ],
    });

    expect(summary.cycles).toEqual({ started: 3, completed: 2, failed: 1, overran: 0 });
    // Only the two cycles that ran contribute.
    expect(summary.totals.requests).toBe(20);
  });

  it('counts cycles that overran their interval', () => {
    const summary = build({
      cycles: [cycle(1), cycle(2, { overran: true, lag_ms: 5_000 }), cycle(3, { overran: true })],
    });

    expect(summary.cycles.overran).toBe(2);
  });

  it('reports peak and sustained window from the timeline', () => {
    let current = 0;
    const timeline = new ThroughputTimeline({ startedAtMs: 0, now: () => current });
    let completed = 0;
    // Three seconds at 600 rpm, then one slow second.
    for (const perSecond of [10, 10, 10, 1]) {
      current += 1_000;
      completed += perSecond;
      timeline.record({
        completed,
        successes: completed,
        failures: 0,
        retries: 0,
        inFlight: 0,
        cycle: 1,
        bytes: 0,
      });
    }

    const summary = build({ cycles: [cycle(1)], timeline, targetRpm: 500 });

    expect(summary.throughput.peak_rpm).toBeCloseTo(600);
    expect(summary.throughput.sustained_target_ms).toBe(3_000);
    expect(summary.timeline).toHaveLength(4);
    expect(summary.timeline[0]?.requests_per_minute).toBeCloseTo(600);
  });

  it('handles a session that produced nothing', () => {
    const summary = build({ cycles: [] });

    expect(summary.totals).toEqual({
      requests: 0,
      successes: 0,
      failures: 0,
      success_rate: 0,
    });
    expect(summary.throughput.active_rpm).toBe(0);
    expect(summary.latency.p95_ms).toBeNull();
  });
});

describe('buildSessionSummary proxies', () => {
  function health(overrides: Partial<ProxyHealth> = {}): ProxyHealth {
    return {
      id: 'http://a:8000',
      label: 'p1',
      source: 'config',
      admittedAt: 0,
      state: 'cooling',
      blockKind: 'consecutive_failures',
      requests: 15,
      successes: 11,
      failures: 4,
      unsuitable: 0,
      consecutiveFailures: 3,
      blocked: true,
      retired: false,
      consecutiveUnsuitable: 0,
      cooldownUntil: Date.parse('2026-08-18T00:05:00.000Z'),
      eligibleAt: Date.parse('2026-08-18T00:05:00.000Z'),
      inUse: false,
      inFlight: 0,
      capacity: 1,
      firstUsedAt: null,
      lastUsedAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      unhealthySince: Date.parse('2026-08-18T00:04:00.000Z'),
      lastReason: 'HTTP 503',
      lastErrorCode: 'http_error',
      ...overrides,
    };
  }

  function proxyStats(perProxy: ProxyHealth[]): ProxyProviderStats {
    return {
      mode: 'static',
      configured: perProxy.length,
      available: 0,
      inUse: 0,
      blocked: 1,
      retired: 0,
      untested: 0,
      cooling: 1,
      saturated: 0,
      totalInFlight: 0,
      capacity: 1,
      poolExhaustedCount: 2,
      totalRequests: 15,
      totalFailures: 4,
      source: null,
      perProxy,
    };
  }

  function cycleWithProxy(n: number, errorCode: string, failures: number): CycleSummary {
    return cycle(n, {
      summary: runSummary({
        proxies: {
          mode: 'static',
          configured: 1,
          used: 1,
          available: 1,
          untested: 0,
          cooling: 0,
          saturated: 0,
          blocked: 0,
          retired: 0,
          total_in_flight: 0,
          capacity: 1,
          pool_exhausted: 0,
          total_failures: failures,
          source: null,
          per_proxy: [
            {
              proxy_id: 'http://a:8000',
              label: 'p1',
              source: 'config',
              state: 'healthy',
              block_kind: null,
              requests: 5,
              successes: 5 - failures,
              failures,
              unsuitable: 0,
              consecutive_failures: 0,
              blocked: false,
              retired: false,
              in_flight: 0,
              capacity: 8,
              unhealthy_since: null,
              eligible_at: null,
              first_used_at: null,
              last_used_at: null,
              last_success_at: null,
              last_failure_at: null,
              last_reason: null,
              last_error_code: null,
              by_platform: { tiktok: { requests: 5, failures } },
              by_error_code: failures === 0 ? {} : { [errorCode]: failures },
              request_bytes: null,
              response_bytes: null,
            },
          ],
        },
      }),
    });
  }

  it('reports the pool as it ended, with attribution merged from every cycle', () => {
    const summary = build({
      cycles: [cycleWithProxy(1, 'http_error', 1), cycleWithProxy(2, 'timeout', 3)],
      proxyStats: proxyStats([health()]),
    });

    // Counters come from the pool, which has been counting all session long.
    expect(summary.proxies.per_proxy[0]).toMatchObject({
      requests: 15,
      successes: 11,
      failures: 4,
      state: 'cooling',
      unhealthy_since: '2026-08-18T00:04:00.000Z',
      eligible_at: '2026-08-18T00:05:00.000Z',
    });
    // Attribution comes from the cycles, whose metrics reset each time.
    expect(summary.proxies.per_proxy[0]?.by_error_code).toEqual({ http_error: 1, timeout: 3 });
    expect(summary.proxies.per_proxy[0]?.by_platform).toEqual({
      tiktok: { requests: 10, failures: 4 },
    });
    expect(summary.proxies.pool_exhausted).toBe(2);
    expect(summary.proxies.cooling).toBe(1);
  });

  it('reports an empty pool for a session that ran without proxies', () => {
    const summary = build({ cycles: [cycle(1)] });

    expect(summary.proxies.configured).toBe(0);
    expect(summary.proxies.per_proxy).toEqual([]);
  });
});
