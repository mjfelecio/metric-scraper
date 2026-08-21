import { z } from 'zod';

import { PlatformSchema } from './platform.js';
import {
  ConcurrencySummarySchema,
  LatencySummarySchema,
  ProxySummarySchema,
  RetrySummarySchema,
  RunSummarySchema,
} from './run-summary.js';
import { ScrapeStatusSchema } from './status.js';

/**
 * Summary of a *session*: a scheduled sequence of cycles, where each cycle is
 * one full pass over the batch.
 *
 * This is the artifact that answers the throughput requirement. It reuses the
 * per-cycle `RunSummary` wholesale rather than restating it, so the two can
 * never disagree about what a cycle did.
 */

export const STOP_REASONS = ['completed', 'max_cycles', 'duration', 'cancelled', 'fatal'] as const;
export const StopReasonSchema = z.enum(STOP_REASONS);
export type StopReasonValue = z.infer<typeof StopReasonSchema>;

export const ThroughputSampleSchema = z.object({
  t_ms: z.number().nonnegative(),
  at: z.string(),
  cycle: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  successes: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  retries: z.number().int().nonnegative(),
  in_flight: z.number().int().nonnegative(),
  requests_per_minute: z.number().nonnegative(),
  successes_per_minute: z.number().nonnegative(),
  failures_per_minute: z.number().nonnegative(),
  retries_per_minute: z.number().nonnegative(),
});
export type ThroughputSampleRecord = z.infer<typeof ThroughputSampleSchema>;

export const CycleSummarySchema = z.object({
  /** 1-based. */
  cycle: z.number().int().positive(),
  scheduled_at: z.string(),
  started_at: z.string(),
  finished_at: z.string(),
  /** How late this cycle started against its schedule. */
  lag_ms: z.number().nonnegative(),
  /** True when the previous cycle ran past its interval window. */
  overran: z.boolean(),
  /** `null` when the cycle failed before producing one. */
  summary: RunSummarySchema.nullable(),
  /** Set when the cycle itself threw. The session continues regardless. */
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type CycleSummary = z.infer<typeof CycleSummarySchema>;

export const StallEpisodeSchema = z.object({
  cycle: z.number().int().positive(),
  started_at: z.string(),
  recovered_at: z.string().nullable(),
  duration_ms: z.number().nonnegative(),
});
export type StallEpisode = z.infer<typeof StallEpisodeSchema>;

export const SessionSummarySchema = z.object({
  session_id: z.string(),
  platform: PlatformSchema.nullable(),
  started_at: z.string(),
  finished_at: z.string(),
  duration_ms: z.number().nonnegative(),

  schedule: z.object({
    interval_ms: z.number().int().nonnegative(),
    /** Requested limits; `null` means unbounded. */
    duration_ms: z.number().int().nonnegative().nullable(),
    max_cycles: z.number().int().positive().nullable(),
    stop_reason: StopReasonSchema,
  }),

  cycles: z.object({
    started: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    /** Cycles that ran past their interval window. */
    overran: z.number().int().nonnegative(),
  }),

  input: z.object({
    candidates: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
  }),

  totals: z.object({
    /** One per URL processed, summed over every cycle. Retries are NOT counted. */
    requests: z.number().int().nonnegative(),
    successes: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
    success_rate: z.number().min(0).max(1),
  }),

  throughput: z.object({
    target_rpm: z.number().nonnegative(),
    /** Aggregated across cycles: the worst-case observed against the configured ceiling. */
    concurrency: ConcurrencySummarySchema,
    /** Requests over the whole session, idle gaps included. Low by design when polling. */
    wall_clock_rpm: z.number().nonnegative(),
    /** Requests over time actually spent scraping, idle gaps excluded. */
    active_rpm: z.number().nonnegative(),
    /** Highest instantaneous rate observed in the timeline. */
    peak_rpm: z.number().nonnegative(),
    /** Longest contiguous stretch at or above `target_rpm` — the requirement, measured. */
    sustained_target_ms: z.number().nonnegative(),
  }),

  latency: LatencySummarySchema,
  status_breakdown: z.record(ScrapeStatusSchema, z.number().int().nonnegative()),
  error_breakdown: z.record(z.string(), z.number().int().nonnegative()),
  retries: RetrySummarySchema,

  queue: z.object({
    max_depth: z.number().int().nonnegative(),
    wait_count: z.number().int().nonnegative(),
    wait_total_ms: z.number().nonnegative(),
    wait_mean_ms: z.number().nonnegative().nullable(),
    wait_max_ms: z.number().nonnegative().nullable(),
  }),
  waits: z.object({
    admission_total_ms: z.number().nonnegative(),
    http_rate_limit_total_ms: z.number().nonnegative(),
    proxy_acquire_total_ms: z.number().nonnegative(),
    retry_backoff_total_ms: z.number().nonnegative(),
  }),

  /**
   * The proxy pool over the whole session.
   *
   * The pool outlives a cycle by design — cooldowns are measured in minutes —
   * so this is the only place that answers "did the pool degrade over the
   * afternoon, or was one cycle unlucky". Counters are cumulative; state is the
   * pool as it stood when the session ended.
   */
  proxies: ProxySummarySchema,

  /** True only when the session ended with an active stall. */
  stalled: z.boolean(),
  /** Distinct periods without completions while work remained in flight. */
  stall_episodes: z.array(StallEpisodeSchema),

  timeline: z.array(ThroughputSampleSchema),

  output: z.object({
    snapshots_path: z.string().nullable(),
    summary_path: z.string().nullable(),
    cycles_dir: z.string().nullable(),
    rows_written: z.number().int().nonnegative(),
  }),
});

export type SessionSummary = z.infer<typeof SessionSummarySchema>;
