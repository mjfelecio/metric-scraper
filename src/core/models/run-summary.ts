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

export const ProxyUsageSchema = z.object({
  /** Stable identifier. Never contains credentials. */
  proxy_id: z.string(),
  requests: z.number().int().nonnegative(),
  successes: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  blocked: z.boolean(),
});
export type ProxyUsage = z.infer<typeof ProxyUsageSchema>;

export const ProxySummarySchema = z.object({
  configured: z.number().int().nonnegative(),
  used: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  total_failures: z.number().int().nonnegative(),
  per_proxy: z.array(ProxyUsageSchema),
});
export type ProxySummary = z.infer<typeof ProxySummarySchema>;

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
    target_rpm: z.number().nonnegative(),
    concurrency: z.number().int().positive(),
  }),

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
