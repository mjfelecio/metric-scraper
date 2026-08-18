import { type MetricsView } from '../metrics/metrics-collector.js';
import { type Platform } from '../models/platform.js';
import { type RunSummary } from '../models/run-summary.js';
import { type ProxyPoolStats, type SessionPoolStats } from '../scraper/pool-ports.js';

import { type RunCounts } from './types.js';

export interface BuildSummaryInput {
  runId: string;
  /** `null` for a mixed-platform run. */
  platform: Platform | null;
  startedAt: Date;
  finishedAt: Date;
  counts: RunCounts;
  metrics: MetricsView;
  proxyStats: ProxyPoolStats;
  sessionStats: SessionPoolStats;
  concurrency: number;
  targetRpm: number;
  snapshotsPath: string | null;
  summaryPath: string | null;
  rowsWritten: number;
}

/**
 * Assembles the machine-readable run summary.
 *
 * Throughput is derived from completed requests only. Retries appear in their
 * own section so a run that retried heavily cannot look faster than it was.
 */
export function buildRunSummary(input: BuildSummaryInput): RunSummary {
  const { metrics } = input;
  const durationMs = Math.max(0, input.finishedAt.getTime() - input.startedAt.getTime());

  const blockedProxies = input.proxyStats.perProxy.filter((proxy) => proxy.blocked).length;

  return {
    run_id: input.runId,
    platform: input.platform,
    started_at: input.startedAt.toISOString(),
    finished_at: input.finishedAt.toISOString(),
    duration_ms: durationMs,

    input: {
      candidates: input.counts.candidates,
      accepted: input.counts.accepted,
      rejected: input.counts.rejected,
    },

    totals: {
      requests: metrics.totalRequests,
      platform_http_requests: metrics.platformHttpRequests,
      successes: metrics.successfulRequests,
      failures: metrics.failedRequests,
      success_rate: metrics.successRate,
    },

    throughput: {
      requests_per_minute: durationMs === 0 ? 0 : (metrics.totalRequests / durationMs) * 60_000,
      target_rpm: input.targetRpm,
      concurrency: {
        configured: input.concurrency,
        max_observed: metrics.concurrency.maxObserved,
        // Measured against the same wall clock the rest of this block uses, so
        // `effective` and `requests_per_minute` can never disagree about the run.
        effective: durationMs === 0 ? 0 : metrics.latencySumMs / durationMs,
        utilization: Math.min(1, metrics.concurrency.utilization),
        saturated: metrics.concurrency.saturated,
      },
    },

    queue: {
      max_depth: metrics.queue.maxDepth,
      wait_p50_ms: metrics.queue.waitP50Ms,
      wait_p95_ms: metrics.queue.waitP95Ms,
      wait_max_ms: metrics.queue.waitMaxMs,
    },

    waits: {
      admission_ms: metrics.waits.admissionMs,
      http_rate_limit_ms: metrics.waits.httpRateLimitMs,
      proxy_acquire_ms: metrics.waits.proxyAcquireMs,
      retry_backoff_ms: metrics.waits.retryBackoffMs,
    },

    latency: {
      count: metrics.latency.count,
      p50_ms: metrics.latency.p50Ms,
      p95_ms: metrics.latency.p95Ms,
      max_ms: metrics.latency.maxMs,
      mean_ms: metrics.latency.meanMs,
    },

    status_breakdown: metrics.statusCounts,
    error_breakdown: metrics.errorCounts,

    retries: {
      total_retries: metrics.totalRetries,
      retried_requests: metrics.retriedRequests,
      exhausted_requests: metrics.exhaustedRequests,
    },

    proxies: {
      configured: input.proxyStats.configured,
      used: metrics.proxyUsage.length,
      blocked: blockedProxies,
      total_failures: input.proxyStats.totalFailures,
      per_proxy: metrics.proxyUsage.map((usage) => ({
        proxy_id: usage.proxyId,
        requests: usage.requests,
        successes: usage.successes,
        failures: usage.failures,
        blocked: usage.blocked,
      })),
    },

    sessions: {
      configured: input.sessionStats.configured,
      used: input.sessionStats.perSession.filter((session) => session.requests > 0).length,
      blocked: input.sessionStats.blocked,
      total_failures: input.sessionStats.perSession.reduce(
        (total, session) => total + session.failures,
        0,
      ),
      per_session: input.sessionStats.perSession.map((session) => ({
        session_id: session.id,
        proxy_id: session.proxyId,
        requests: session.requests,
        failures: session.failures,
        blocked: session.blocked,
      })),
    },

    output: {
      snapshots_path: input.snapshotsPath,
      summary_path: input.summaryPath,
      rows_written: input.rowsWritten,
    },
  };
}
