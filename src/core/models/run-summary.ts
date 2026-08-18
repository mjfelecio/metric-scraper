import { z } from 'zod';

import { PlatformSchema } from './platform.js';
import { ScrapeStatusSchema } from './status.js';

export const LatencySummarySchema = z.object({
  count: z.number().int().nonnegative(),
  p50_ms: z.number().nonnegative().nullable(),
  p95_ms: z.number().nonnegative().nullable(),
  max_ms: z.number().nonnegative().nullable(),
  mean_ms: z.number().nonnegative().nullable(),
});
export type LatencySummary = z.infer<typeof LatencySummarySchema>;

/**
 * Per-proxy tallies, classified exactly as the pool's rotation classified them.
 *
 * `successes` means "healthy use of this proxy", so a `not_found` or `private`
 * answer counts here: the proxy delivered a definitive result and the pool
 * credits it. Per-URL outcomes live in `status_breakdown` instead. Anything
 * counted in `failures` is something rotation acted on.
 */
export const ProxyUsageSchema = z.object({
  /** Stable identifier. Never contains credentials. */
  proxy_id: z.string(),
  requests: z.number().int().nonnegative(),
  successes: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  /** Subset of `failures` blamed on the exit node itself (HTTP 451). */
  unsuitable: z.number().int().nonnegative(),
  blocked: z.boolean(),
});
export type ProxyUsage = z.infer<typeof ProxyUsageSchema>;

export const ProxySummarySchema = z.object({
  configured: z.number().int().nonnegative(),
  used: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  /** Proxies taken out of rotation for good as unsuitable exit nodes. */
  retired: z.number().int().nonnegative(),
  total_failures: z.number().int().nonnegative(),
  per_proxy: z.array(ProxyUsageSchema),
});
export type ProxySummary = z.infer<typeof ProxySummarySchema>;

/**
 * Configured vs. actual concurrency.
 *
 * Reporting only the configured number is how an effective concurrency of 1
 * hid behind a configured 10 for an entire run. `max_observed` and `effective`
 * are measurements, so the two can never silently disagree again.
 */
export const ConcurrencySummarySchema = z.object({
  configured: z.number().int().positive(),
  /** High-water mark of jobs actually running at once. */
  max_observed: z.number().int().nonnegative(),
  /** Mean in-flight: `Σ(latency) / wall clock`. ~1.0 means the run was sequential. */
  effective: z.number().nonnegative(),
  /** `max_observed / configured`, 0..1. */
  utilization: z.number().min(0).max(1),
  /** Whether the configured ceiling was ever actually reached. */
  saturated: z.boolean(),
});
export type ConcurrencySummary = z.infer<typeof ConcurrencySummarySchema>;

export const QueueSummarySchema = z.object({
  /** Deepest the backlog of waiting jobs ever got. */
  max_depth: z.number().int().nonnegative(),
  wait_p50_ms: z.number().nonnegative().nullable(),
  wait_p95_ms: z.number().nonnegative().nullable(),
  wait_max_ms: z.number().nonnegative().nullable(),
});
export type QueueSummary = z.infer<typeof QueueSummarySchema>;

/** Wall-clock time spent waiting rather than requesting, so a run stays attributable. */
export const WaitSummarySchema = z.object({
  /** On the job-admission limiter, outside any concurrency slot. */
  admission_ms: z.number().nonnegative(),
  /** On the per-host HTTP limiter, inside a concurrency slot. */
  http_rate_limit_ms: z.number().nonnegative(),
  proxy_acquire_ms: z.number().nonnegative(),
  /** Retry backoff, which holds a concurrency slot while it sleeps. */
  retry_backoff_ms: z.number().nonnegative(),
});
export type WaitSummary = z.infer<typeof WaitSummarySchema>;

export const RetrySummarySchema = z.object({
  /**
   * Total retry attempts across the run. Counted separately from `requests`
   * so that throughput is never inflated by retries.
   */
  total_retries: z.number().int().nonnegative(),
  /** Requests that needed at least one retry. */
  retried_requests: z.number().int().nonnegative(),
  /** Requests that used every allowed attempt and still failed. */
  exhausted_requests: z.number().int().nonnegative(),
});
export type RetrySummary = z.infer<typeof RetrySummarySchema>;

export const RunSummarySchema = z.object({
  run_id: z.string(),
  /** `null` for a mixed-platform run. */
  platform: PlatformSchema.nullable(),
  started_at: z.string(),
  finished_at: z.string(),
  duration_ms: z.number().nonnegative(),

  input: z.object({
    candidates: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
  }),

  totals: z.object({
    /** One per URL processed. Retries are NOT counted here. */
    requests: z.number().int().nonnegative(),
    /** Underlying first-party HTTP calls, including multi-call jobs and retries. */
    platform_http_requests: z.number().int().nonnegative(),
    successes: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
    /** 0..1 */
    success_rate: z.number().min(0).max(1),
  }),

  throughput: z.object({
    requests_per_minute: z.number().nonnegative(),
    /** Logical scrape jobs admitted per minute. One URL = one unit. */
    target_rpm: z.number().nonnegative(),
    concurrency: ConcurrencySummarySchema,
  }),

  queue: QueueSummarySchema,
  waits: WaitSummarySchema,

  latency: LatencySummarySchema,

  status_breakdown: z.record(ScrapeStatusSchema, z.number().int().nonnegative()),
  /** Counts keyed by `ScrapeErrorCode`. Empty on a clean run. */
  error_breakdown: z.record(z.string(), z.number().int().nonnegative()),

  retries: RetrySummarySchema,
  proxies: ProxySummarySchema,

  sessions: z.object({
    configured: z.number().int().nonnegative(),
    used: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    total_failures: z.number().int().nonnegative(),
    per_session: z.array(
      z.object({
        session_id: z.string(),
        proxy_id: z.string().nullable(),
        requests: z.number().int().nonnegative(),
        failures: z.number().int().nonnegative(),
        blocked: z.boolean(),
      }),
    ),
  }),

  output: z.object({
    snapshots_path: z.string().nullable(),
    summary_path: z.string().nullable(),
    rows_written: z.number().int().nonnegative(),
  }),
});

export type RunSummary = z.infer<typeof RunSummarySchema>;
