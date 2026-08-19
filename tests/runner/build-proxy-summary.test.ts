import { describe, expect, it } from 'vitest';

import { type ProxyUsageView } from '../../src/core/metrics/metrics-collector.js';
import { type ProxyUsage } from '../../src/core/models/run-summary.js';
import { buildProxySummary, mergeProxyUsage } from '../../src/core/runner/build-proxy-summary.js';
import { type ProxyHealth, type ProxyPoolStats } from '../../src/core/scraper/pool-ports.js';

const COOLING_UNTIL = Date.parse('2026-08-18T19:26:00.000Z');
const WENT_BAD_AT = Date.parse('2026-08-18T19:21:00.000Z');

function health(overrides: Partial<ProxyHealth> = {}): ProxyHealth {
  return {
    id: 'http://gate-a.example.net:8000',
    label: 'p1',
    source: 'config',
    admittedAt: 0,
    state: 'healthy',
    blockKind: null,
    requests: 0,
    successes: 0,
    failures: 0,
    unsuitable: 0,
    consecutiveFailures: 0,
    consecutiveUnsuitable: 0,
    blocked: false,
    retired: false,
    cooldownUntil: null,
    eligibleAt: null,
    inUse: false,
    inFlight: 0,
    capacity: 8,
    firstUsedAt: null,
    lastUsedAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    unhealthySince: null,
    lastReason: null,
    lastErrorCode: null,
    ...overrides,
  };
}

function stats(perProxy: ProxyHealth[], overrides: Partial<ProxyPoolStats> = {}): ProxyPoolStats {
  return {
    configured: perProxy.length,
    available: perProxy.filter((entry) => entry.state !== 'cooling' && entry.state !== 'retired')
      .length,
    inUse: perProxy.filter((entry) => entry.inFlight > 0).length,
    blocked: perProxy.filter((entry) => entry.blocked).length,
    retired: perProxy.filter((entry) => entry.retired).length,
    untested: perProxy.filter((entry) => entry.state === 'untested').length,
    cooling: perProxy.filter((entry) => entry.state === 'cooling').length,
    saturated: perProxy.filter((entry) => entry.state === 'saturated').length,
    totalInFlight: perProxy.reduce((total, entry) => total + entry.inFlight, 0),
    capacity: 16,
    poolExhaustedCount: 0,
    totalRequests: perProxy.reduce((total, entry) => total + entry.requests, 0),
    totalFailures: perProxy.reduce((total, entry) => total + entry.failures, 0),
    source: null,
    perProxy,
    ...overrides,
  };
}

function usage(overrides: Partial<ProxyUsageView> = {}): ProxyUsageView {
  return {
    proxyId: 'http://gate-a.example.net:8000',
    requests: 0,
    successes: 0,
    failures: 0,
    unsuitable: 0,
    blocked: false,
    byPlatform: {},
    byErrorCode: {},
    ...overrides,
  };
}

describe('buildProxySummary', () => {
  it('joins pool state onto the metrics tallies for the same proxy', () => {
    const summary = buildProxySummary(
      stats([
        health({
          state: 'cooling',
          blockKind: 'consecutive_failures',
          blocked: true,
          consecutiveFailures: 3,
          unhealthySince: WENT_BAD_AT,
          eligibleAt: COOLING_UNTIL,
          lastErrorCode: 'http_error',
          lastReason: 'HTTP 503',
        }),
      ]),
      [
        usage({
          requests: 42,
          successes: 38,
          failures: 4,
          byPlatform: { tiktok: { requests: 42, failures: 4 } },
          byErrorCode: { http_error: 3, blocked: 1 },
        }),
      ],
    );

    const proxy = summary.per_proxy[0]!;
    expect(proxy).toMatchObject({
      label: 'p1',
      state: 'cooling',
      block_kind: 'consecutive_failures',
      requests: 42,
      successes: 38,
      failures: 4,
      unhealthy_since: '2026-08-18T19:21:00.000Z',
      eligible_at: '2026-08-18T19:26:00.000Z',
      last_error_code: 'http_error',
    });
    expect(proxy.by_error_code).toEqual({ http_error: 3, blocked: 1 });
    expect(proxy.by_platform).toEqual({ tiktok: { requests: 42, failures: 4 } });
  });

  it('still lists a configured proxy that was never used', () => {
    const summary = buildProxySummary(
      stats([
        health({ id: 'http://a:8000', state: 'untested' }),
        health({ id: 'http://b:8000', label: 'p2' }),
      ]),
      [usage({ proxyId: 'http://b:8000', requests: 5, successes: 5 })],
    );

    // "10 configured, 6 usable" is only readable if the quiet ones are there.
    expect(summary.per_proxy).toHaveLength(2);
    expect(summary.used).toBe(1);
    expect(summary.per_proxy[0]?.requests).toBe(0);
  });

  it('falls back to the pool counters when the metrics have nothing to say', () => {
    // The session summary uses this: the pool has counted all session long,
    // while a cycle's metrics start empty.
    const summary = buildProxySummary(
      stats([health({ requests: 9, successes: 7, failures: 2 })]),
      [],
    );

    expect(summary.per_proxy[0]).toMatchObject({ requests: 9, successes: 7, failures: 2 });
    expect(summary.used).toBe(1);
  });
});

describe('mergeProxyUsage', () => {
  function row(overrides: Partial<ProxyUsage> = {}): ProxyUsage {
    return {
      proxy_id: 'http://a:8000',
      label: 'p1',
      source: 'config',
      state: 'healthy',
      block_kind: null,
      requests: 10,
      successes: 9,
      failures: 1,
      unsuitable: 0,
      consecutive_failures: 0,
      blocked: false,
      retired: false,
      in_flight: 0,
      capacity: 8,
      unhealthy_since: null,
      eligible_at: null,
      first_used_at: '2026-08-18T19:00:00.000Z',
      last_used_at: '2026-08-18T19:05:00.000Z',
      last_success_at: null,
      last_failure_at: null,
      last_reason: null,
      last_error_code: null,
      by_platform: { tiktok: { requests: 10, failures: 1 } },
      by_error_code: { http_error: 1 },
      ...overrides,
    };
  }

  it('adds counters across cycles but keeps the latest state', () => {
    const merged = mergeProxyUsage([
      row(),
      row({
        state: 'cooling',
        blocked: true,
        requests: 5,
        successes: 2,
        failures: 3,
        first_used_at: '2026-08-18T19:10:00.000Z',
        by_platform: { tiktok: { requests: 5, failures: 3 } },
        by_error_code: { http_error: 2, timeout: 1 },
      }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      requests: 15,
      successes: 11,
      failures: 4,
      // Health is a point in time; the last cycle's word is the one that stands.
      state: 'cooling',
      blocked: true,
      // The first time it was ever used stays the first time.
      first_used_at: '2026-08-18T19:00:00.000Z',
    });
    expect(merged[0]?.by_error_code).toEqual({ http_error: 3, timeout: 1 });
    expect(merged[0]?.by_platform).toEqual({ tiktok: { requests: 15, failures: 4 } });
  });

  it('keeps proxies apart', () => {
    const merged = mergeProxyUsage([row(), row({ proxy_id: 'http://b:8000', label: 'p2' })]);
    expect(merged.map((entry) => entry.proxy_id)).toEqual(['http://a:8000', 'http://b:8000']);
  });
});
