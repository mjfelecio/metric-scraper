import { type MetricsView } from '../metrics/metrics-collector.js';
import { type Platform } from '../models/platform.js';
import { type RunSummary } from '../models/run-summary.js';
import { type SessionPoolStats } from '../scraper/pool-ports.js';
import { type ProxyProviderStats } from '../scraper/provider-ports.js';

import { buildProxySummary } from './build-proxy-summary.js';
import { type RunCounts } from './types.js';

export interface BuildSummaryInput {
  runId: string;
  /** `null` for a mixed-platform run. */
  platform: Platform | null;
  startedAt: Date;
  finishedAt: Date;
  counts: RunCounts;
  metrics: MetricsView;
  proxyStats: ProxyProviderStats;
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

    bandwidth:
      metrics.bandwidth === null
        ? null
        : {
            requests: metrics.bandwidth.requests,
            request_bytes: metrics.bandwidth.requestBytes,
            response_bytes: metrics.bandwidth.responseBytes,
            total_bytes: metrics.bandwidth.totalBytes,
            bytes_per_request: metrics.bandwidth.bytesPerRequest,
          },

    queue: {
      max_depth: metrics.queue.maxDepth,
      wait_count: metrics.queue.waitCount,
      wait_total_ms: metrics.queue.waitTotalMs,
      wait_mean_ms: metrics.queue.waitMeanMs,
      wait_p50_ms: metrics.queue.waitP50Ms,
      wait_p95_ms: metrics.queue.waitP95Ms,
      wait_max_ms: metrics.queue.waitMaxMs,
    },

    waits: {
      admission_total_ms: metrics.waits.admissionTotalMs,
      http_rate_limit_total_ms: metrics.waits.httpRateLimitTotalMs,
      proxy_acquire_total_ms: metrics.waits.proxyAcquireTotalMs,
      retry_backoff_total_ms: metrics.waits.retryBackoffTotalMs,
      admission_ms: metrics.waits.admissionTotalMs,
      http_rate_limit_ms: metrics.waits.httpRateLimitTotalMs,
      proxy_acquire_ms: metrics.waits.proxyAcquireTotalMs,
      retry_backoff_ms: metrics.waits.retryBackoffTotalMs,
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

    // Pool state joined with the metrics tallies, so the section says what each
    // proxy is *doing* and not only how many requests it carried.
    proxies: buildProxySummary(input.proxyStats, metrics.proxyUsage),

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
