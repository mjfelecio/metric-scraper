import { type MetricsView } from '../metrics/metrics-collector.js';
import { type Platform } from '../models/platform.js';
import { type RunSummary } from '../models/run-summary.js';
import { type ProxyPoolStats } from '../scraper/pool-ports.js';

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
      successes: metrics.successfulRequests,
      failures: metrics.failedRequests,
      success_rate: metrics.successRate,
    },

    throughput: {
      requests_per_minute: durationMs === 0 ? 0 : (metrics.totalRequests / durationMs) * 60_000,
      target_rpm: input.targetRpm,
      concurrency: input.concurrency,
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

    output: {
      snapshots_path: input.snapshotsPath,
      summary_path: input.summaryPath,
      rows_written: input.rowsWritten,
    },
  };
}
