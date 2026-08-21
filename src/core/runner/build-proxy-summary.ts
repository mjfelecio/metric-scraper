import { type ProxyUsageView } from '../metrics/metrics-collector.js';
import {
  type ProxySourceSummary,
  type ProxySummary,
  type ProxyUsage,
} from '../models/run-summary.js';
import { type ProxyHealth } from '../scraper/pool-ports.js';
import { type ProxyProviderStats } from '../scraper/provider-ports.js';
import { type ProxySourceStats } from '../scraper/proxy-source-ports.js';

/**
 * Joins what the provider knows (state, timestamps, why it benched something)
 * with what the metrics counted (requests, and which platform and error code
 * they came from) into the proxy section of a summary.
 *
 * The provider is the authority on *which* proxies exist, so a proxy that was
 * configured and never used still gets a row — "10 configured, 6 usable, 2
 * cooling" is only readable if the quiet ones are listed too. The tallies come
 * from the metrics, which are fed by the same classification the pool rotates
 * on, so the two halves of a row can never disagree.
 *
 * `mode` is carried through unchanged and decides how the result reads: under
 * `rotating-residential` there is exactly one row, and it is the gateway rather
 * than a proxy.
 */
export function buildProxySummary(
  stats: ProxyProviderStats,
  usage: readonly ProxyUsageView[],
): ProxySummary {
  const byId = new Map(usage.map((entry) => [entry.proxyId, entry]));
  const perProxy: ProxyUsage[] = stats.perProxy.map((health) => toRow(health, byId.get(health.id)));

  // Anything the metrics saw but the pool did not list. Only reachable through
  // a pool that hands out ids it does not report; the tallies are still real,
  // so they are kept rather than quietly dropped.
  for (const entry of usage) {
    if (stats.perProxy.some((health) => health.id === entry.proxyId)) continue;
    perProxy.push(toRow(unknownHealth(entry.proxyId), entry));
  }

  return {
    mode: stats.mode,
    configured: stats.configured,
    used: perProxy.filter((proxy) => proxy.requests > 0).length,
    available: stats.available,
    untested: stats.untested,
    cooling: stats.cooling,
    saturated: stats.saturated,
    blocked: stats.blocked,
    retired: stats.retired,
    total_in_flight: stats.totalInFlight,
    capacity: stats.capacity,
    pool_exhausted: stats.poolExhaustedCount,
    total_failures: stats.totalFailures,
    source: sourceRow(stats.source),
    per_proxy: perProxy,
  };
}

function sourceRow(source: ProxySourceStats | null): ProxySourceSummary | null {
  if (source === null) return null;
  return {
    name: source.name,
    candidates: source.candidates,
    validating: source.validating,
    admitted: source.admitted,
    rejected: source.rejected,
    fetched: source.fetched,
    malformed: source.malformed,
    duplicates: source.duplicates,
    refreshes: source.refreshes,
    refresh_failures: source.refreshFailures,
    last_refresh_at: iso(source.lastRefreshAt),
    last_refresh_error: source.lastRefreshError,
    probe_successes: source.probeSuccesses,
    probe_failures: source.probeFailures,
    probe_failures_by_stage: { ...source.probeFailuresByStage },
    admitted_total: source.admittedTotal,
    admitted_tried: source.admittedTried,
    admitted_proven: source.admittedProven,
    admission_to_first_success_rate: source.admissionToFirstSuccessRate,
    target_capacity: source.targetCapacity,
  };
}

/**
 * Sums per-proxy rows from several cycles into one.
 *
 * Counters add; health does not. A proxy's state, timestamps and last reason
 * are point-in-time facts, so the latest row wins — averaging "cooling" with
 * "healthy" would describe a proxy that never existed.
 */
export function mergeProxyUsage(rows: readonly ProxyUsage[]): ProxyUsage[] {
  const merged = new Map<string, ProxyUsage>();

  for (const row of rows) {
    const previous = merged.get(row.proxy_id);
    if (previous === undefined) {
      merged.set(row.proxy_id, {
        ...row,
        by_platform: { ...row.by_platform },
        by_error_code: { ...row.by_error_code },
      });
      continue;
    }

    merged.set(row.proxy_id, {
      ...row,
      requests: previous.requests + row.requests,
      successes: previous.successes + row.successes,
      failures: previous.failures + row.failures,
      unsuitable: previous.unsuitable + row.unsuitable,
      blocked: previous.blocked || row.blocked,
      retired: previous.retired || row.retired,
      first_used_at: previous.first_used_at ?? row.first_used_at,
      by_platform: addPlatforms(previous.by_platform, row.by_platform),
      by_error_code: addCounts(previous.by_error_code, row.by_error_code),
      request_bytes: addNullableBytes(previous.request_bytes, row.request_bytes),
      response_bytes: addNullableBytes(previous.response_bytes, row.response_bytes),
    });
  }

  return [...merged.values()];
}

/**
 * Sums two nullable byte counts, keeping the null-vs-0 distinction: `null`
 * means "not measured this cycle", not "measured zero".
 *
 * A cycle that never measured bandwidth (metrics off, or this proxy carried
 * no traffic that cycle) contributes nothing, not a zero that would otherwise
 * be indistinguishable from a cycle that measured and truly saw no bytes.
 * Only when every contributing cycle is null does the merged total stay
 * null; as soon as one cycle has a real measurement, the total is real.
 */
function addNullableBytes(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

function toRow(health: ProxyHealth, usage: ProxyUsageView | undefined): ProxyUsage {
  return {
    proxy_id: health.id,
    label: health.label,
    source: health.source,
    state: health.state,
    block_kind: health.blockKind,
    // The pool's own counters are the fallback: a cycle's metrics start empty,
    // but the pool has been counting since the session began.
    requests: usage?.requests ?? health.requests,
    successes: usage?.successes ?? health.successes,
    failures: usage?.failures ?? health.failures,
    unsuitable: usage?.unsuitable ?? health.unsuitable,
    consecutive_failures: health.consecutiveFailures,
    blocked: health.blocked || (usage?.blocked ?? false),
    retired: health.retired,
    in_flight: health.inFlight,
    capacity: health.capacity,
    unhealthy_since: iso(health.unhealthySince),
    eligible_at: iso(health.eligibleAt),
    first_used_at: iso(health.firstUsedAt),
    last_used_at: iso(health.lastUsedAt),
    last_success_at: iso(health.lastSuccessAt),
    last_failure_at: iso(health.lastFailureAt),
    last_reason: health.lastReason,
    last_error_code: health.lastErrorCode,
    by_platform: { ...(usage?.byPlatform ?? {}) },
    by_error_code: { ...(usage?.byErrorCode ?? {}) },
    // `null` rather than falling back to a pool counter: the pool has no notion
    // of bytes, so there is no "since the session began" figure to fall back to.
    request_bytes: usage?.requestBytes ?? null,
    response_bytes: usage?.responseBytes ?? null,
  };
}

/** Stand-in for an id the pool did not report; nothing is known about it. */
function unknownHealth(id: string): ProxyHealth {
  return {
    id,
    label: '?',
    source: 'unknown',
    admittedAt: 0,
    state: 'untested',
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
    capacity: null,
    firstUsedAt: null,
    lastUsedAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    unhealthySince: null,
    lastReason: null,
    lastErrorCode: null,
  };
}

function addPlatforms(
  a: ProxyUsage['by_platform'],
  b: ProxyUsage['by_platform'],
): ProxyUsage['by_platform'] {
  const result: ProxyUsage['by_platform'] = { ...a };
  for (const [platform, counts] of Object.entries(b)) {
    const previous = result[platform] ?? { requests: 0, failures: 0 };
    result[platform] = {
      requests: previous.requests + counts.requests,
      failures: previous.failures + counts.failures,
    };
  }
  return result;
}

function addCounts(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const result: Record<string, number> = { ...a };
  for (const [key, count] of Object.entries(b)) {
    result[key] = (result[key] ?? 0) + count;
  }
  return result;
}

function iso(epochMs: number | null): string | null {
  return epochMs === null ? null : new Date(epochMs).toISOString();
}
