import { max as maxOf, mean, percentileOfSorted } from '../metrics/percentiles.js';
import { type ThroughputTimeline } from '../metrics/throughput-timeline.js';
import { type Platform } from '../models/platform.js';
import {
  type CycleSummary,
  type SessionSummary,
  type StopReasonValue,
  type ThroughputSampleRecord,
} from '../models/session-summary.js';
import { SCRAPE_STATUSES, type ScrapeStatus } from '../models/status.js';

import { type RunCounts } from './types.js';

export interface BuildSessionSummaryInput {
  sessionId: string;
  platform: Platform | null;
  startedAt: Date;
  finishedAt: Date;
  counts: RunCounts;
  cycles: readonly CycleSummary[];
  /** Every observed latency, so percentiles stay nearest-rank over real samples. */
  latenciesMs: readonly number[];
  timeline: ThroughputTimeline;
  schedule: {
    intervalMs: number;
    durationMs: number | null;
    maxCycles: number | null;
    stopReason: StopReasonValue;
  };
  concurrency: number;
  targetRpm: number;
  stalled: boolean;
  snapshotsPath: string | null;
  summaryPath: string | null;
  cyclesDir: string | null;
  rowsWritten: number;
}

function emptyStatusCounts(): Record<ScrapeStatus, number> {
  const counts = {} as Record<ScrapeStatus, number>;
  for (const status of SCRAPE_STATUSES) counts[status] = 0;
  return counts;
}

/**
 * Aggregates a session from its cycles.
 *
 * Totals, breakdowns and retry statistics are summed from the per-cycle
 * `RunSummary` objects, so there is exactly one definition of what a cycle did.
 * Latency is recomputed from the raw samples instead of averaging the cycles'
 * percentiles, because an average of p95s is not a p95 — and this project's
 * contract is that a reported percentile is always an observed value.
 *
 * Two throughput figures are reported because one number cannot serve both
 * modes: a 15-minute poll has a deliberately tiny wall-clock rate while still
 * achieving full rate whenever it is actually working. Retries appear only in
 * their own section and are never folded into either figure.
 */
export function buildSessionSummary(input: BuildSessionSummaryInput): SessionSummary {
  const durationMs = Math.max(0, input.finishedAt.getTime() - input.startedAt.getTime());

  const statusBreakdown = emptyStatusCounts();
  const errorBreakdown: Record<string, number> = {};

  let requests = 0;
  let successes = 0;
  let failures = 0;
  let totalRetries = 0;
  let retriedRequests = 0;
  let exhaustedRequests = 0;
  let activeMs = 0;
  let completedCycles = 0;
  let failedCycles = 0;
  let overranCycles = 0;
  let maxObservedConcurrency = 0;
  let queueMaxDepth = 0;

  for (const cycle of input.cycles) {
    if (cycle.overran) overranCycles += 1;
    if (cycle.error !== null) failedCycles += 1;

    const { summary } = cycle;
    if (summary === null) continue;

    completedCycles += 1;
    activeMs += summary.duration_ms;
    requests += summary.totals.requests;
    successes += summary.totals.successes;
    failures += summary.totals.failures;
    totalRetries += summary.retries.total_retries;
    retriedRequests += summary.retries.retried_requests;
    exhaustedRequests += summary.retries.exhausted_requests;
    maxObservedConcurrency = Math.max(
      maxObservedConcurrency,
      summary.throughput.concurrency.max_observed,
    );
    queueMaxDepth = Math.max(queueMaxDepth, summary.queue.max_depth);

    for (const [status, count] of Object.entries(summary.status_breakdown)) {
      statusBreakdown[status as ScrapeStatus] += count ?? 0;
    }
    for (const [code, count] of Object.entries(summary.error_breakdown)) {
      errorBreakdown[code] = (errorBreakdown[code] ?? 0) + (count ?? 0);
    }
  }

  const sortedLatencies = [...input.latenciesMs].sort((a, b) => a - b);
  const perMinute = (windowMs: number): number =>
    windowMs === 0 ? 0 : (requests / windowMs) * 60_000;

  return {
    session_id: input.sessionId,
    platform: input.platform,
    started_at: input.startedAt.toISOString(),
    finished_at: input.finishedAt.toISOString(),
    duration_ms: durationMs,

    schedule: {
      interval_ms: input.schedule.intervalMs,
      duration_ms: input.schedule.durationMs,
      max_cycles: input.schedule.maxCycles,
      stop_reason: input.schedule.stopReason,
    },

    cycles: {
      started: input.cycles.length,
      completed: completedCycles,
      failed: failedCycles,
      overran: overranCycles,
    },

    input: {
      candidates: input.counts.candidates,
      accepted: input.counts.accepted,
      rejected: input.counts.rejected,
    },

    totals: {
      requests,
      successes,
      failures,
      success_rate: requests === 0 ? 0 : successes / requests,
    },

    throughput: {
      target_rpm: input.targetRpm,
      concurrency: {
        configured: input.concurrency,
        max_observed: maxObservedConcurrency,
        // Measured against time actually spent scraping: idle gaps between
        // cycles would otherwise make a healthy polling session look sequential.
        effective:
          activeMs === 0
            ? 0
            : input.latenciesMs.reduce((total, latency) => total + latency, 0) / activeMs,
        utilization:
          input.concurrency === 0 ? 0 : Math.min(1, maxObservedConcurrency / input.concurrency),
        saturated: input.concurrency > 0 && maxObservedConcurrency >= input.concurrency,
      },
      wall_clock_rpm: perMinute(durationMs),
      active_rpm: perMinute(activeMs),
      peak_rpm: input.timeline.peakRequestsPerMinute(),
      sustained_target_ms: input.timeline.sustained(input.targetRpm).windowMs,
    },

    latency: {
      count: sortedLatencies.length,
      p50_ms: percentileOfSorted(sortedLatencies, 50),
      p95_ms: percentileOfSorted(sortedLatencies, 95),
      max_ms: maxOf(sortedLatencies),
      mean_ms: mean(sortedLatencies),
    },

    status_breakdown: statusBreakdown,
    error_breakdown: errorBreakdown,

    retries: {
      total_retries: totalRetries,
      retried_requests: retriedRequests,
      exhausted_requests: exhaustedRequests,
    },

    stalled: input.stalled,

    timeline: input.timeline.samples().map((sample): ThroughputSampleRecord => ({
      t_ms: sample.tMs,
      at: sample.at,
      cycle: sample.cycle,
      completed: sample.completed,
      successes: sample.successes,
      failures: sample.failures,
      retries: sample.retries,
      in_flight: sample.inFlight,
      requests_per_minute: sample.requestsPerMinute,
      successes_per_minute: sample.successesPerMinute,
      failures_per_minute: sample.failuresPerMinute,
      retries_per_minute: sample.retriesPerMinute,
    })),

    output: {
      snapshots_path: input.snapshotsPath,
      summary_path: input.summaryPath,
      cycles_dir: input.cyclesDir,
      rows_written: input.rowsWritten,
    },
  };
}
