import { z } from 'zod';

import { PROXY_STATES } from '../scraper/pool-ports.js';

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
 * Per-proxy tallies and health, classified exactly as the pool's rotation
 * classified them.
 *
 * `successes` means "healthy use of this proxy", so a `not_found` or `private`
 * answer counts here: the proxy delivered a definitive result and the pool
 * credits it. Per-URL outcomes live in `status_breakdown` instead. Anything
 * counted in `failures` is something rotation acted on.
 *
 * The health fields are the pool's own state at the end of the run, not a
 * second opinion about it — which is what makes "proxy X handled 42 jobs,
 * became unhealthy at 19:21, and was due back at 19:26" readable from the
 * artifact alone.
 */
export const ProxyStateSchema = z.enum(PROXY_STATES);
export type ProxyStateValue = z.infer<typeof ProxyStateSchema>;

export const ProxyPlatformUsageSchema = z.object({
  requests: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
});

export const ProxyUsageSchema = z.object({
  /** Stable identifier. Never contains credentials. */
  proxy_id: z.string(),
  /** `p1`…`pN`, from configuration order. Stable within a run. */
  label: z.string(),
  /** `config`, or the name of the source that supplied this proxy. */
  source: z.string(),
  state: ProxyStateSchema,
  /** Why it is out of rotation: consecutive_failures, detected_block, unsuitable_exit. */
  block_kind: z.string().nullable(),
  requests: z.number().int().nonnegative(),
  successes: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  /** Subset of `failures` blamed on the exit node itself (HTTP 451). */
  unsuitable: z.number().int().nonnegative(),
  consecutive_failures: z.number().int().nonnegative(),
  blocked: z.boolean(),
  retired: z.boolean(),
  /** Historical row retained after removal from the live roster. */
  evicted: z.boolean(),
  eviction_count: z.number().int().nonnegative(),
  evicted_at: z.string().datetime().nullable(),
  /** Leases held at the moment the summary was taken. */
  in_flight: z.number().int().nonnegative(),
  /** Jobs it may hold at once given its health; `null` when unlimited. */
  capacity: z.number().int().nonnegative().nullable(),
  /** When it entered its current out-of-rotation state; `null` while usable. */
  unhealthy_since: z.string().nullable(),
  /** When it becomes eligible again; `null` when usable now or retired for good. */
  eligible_at: z.string().nullable(),
  first_used_at: z.string().nullable(),
  last_used_at: z.string().nullable(),
  last_success_at: z.string().nullable(),
  last_failure_at: z.string().nullable(),
  /** Last non-success reason, redacted and truncated. */
  last_reason: z.string().nullable(),
  last_error_code: z.string().nullable(),
  /** Requests and failures split by platform. */
  by_platform: z.record(z.string(), ProxyPlatformUsageSchema),
  /** Failure reasons keyed by `ScrapeErrorCode`, including neutral outcomes. */
  by_error_code: z.record(z.string(), z.number().int().nonnegative()),
  /** Wire bytes sent through this proxy. `null` when `METRICS_BANDWIDTH` is off or unmeasured. */
  request_bytes: z.number().int().nonnegative().nullable(),
  /** Wire bytes received through this proxy. `null` when `METRICS_BANDWIDTH` is off or unmeasured. */
  response_bytes: z.number().int().nonnegative().nullable(),
});
export type ProxyUsage = z.infer<typeof ProxyUsageSchema>;

/**
 * Where the pool's capacity came from, when a live candidate source is used.
 *
 * `null` for a statically configured pool, which is what tells the two apart
 * when reading a run back months later.
 */
export const ProxySourceSummarySchema = z.object({
  name: z.string(),
  /** Known, validated but not yet needed. */
  candidates: z.number().int().nonnegative(),
  validating: z.number().int().nonnegative(),
  admitted: z.number().int().nonnegative(),
  /** Rejected for this process and never retried, however often they reappear. */
  rejected: z.number().int().nonnegative(),
  fetched: z.number().int().nonnegative(),
  malformed: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  refreshes: z.number().int().nonnegative(),
  refresh_failures: z.number().int().nonnegative(),
  last_refresh_at: z.string().datetime().nullable(),
  last_refresh_error: z.string().nullable(),
  probe_successes: z.number().int().nonnegative(),
  probe_failures: z.number().int().nonnegative(),
  /**
   * Probe failures split by the layer that rejected them.
   *
   * `connect` is a dead host, `tunnel` is a host that is not a proxy, `tls` is
   * a proxy intercepting our traffic, `response` is one rewriting it. Reading a
   * run back, this is what says whether the candidate list went stale or the
   * probe is doing its job.
   */
  probe_failures_by_stage: z.object({
    connect: z.number().int().nonnegative(),
    tunnel: z.number().int().nonnegative(),
    tls: z.number().int().nonnegative(),
    response: z.number().int().nonnegative(),
  }),
  /** Candidates ever admitted. Cumulative, unlike the `admitted` gauge. */
  admitted_total: z.number().int().nonnegative(),
  /** Of those, how many the pool ever actually leased. */
  admitted_tried: z.number().int().nonnegative(),
  /** Of those tried, how many went on to record a real success. */
  admitted_proven: z.number().int().nonnegative(),
  /**
   * `admitted_proven / admitted_tried`. `null` before anything was tried.
   *
   * The measured answer to "is our validation predictive", recorded per run so
   * a change to the probe can be judged against evidence rather than intent.
   * Note the denominator: a proxy the run never needed is not a failed
   * admission, and counting it as one would make the rate fall as the pool got
   * healthier.
   */
  admission_to_first_success_rate: z.number().min(0).max(1).nullable(),
  evictions: z.number().int().nonnegative(),
  /** Usable capacity the supply aims at, in concurrent slots. */
  target_capacity: z.number().int().nonnegative(),
});
export type ProxySourceSummary = z.infer<typeof ProxySourceSummarySchema>;

export const ProxySummarySchema = z.object({
  /**
   * Which proxy implementation the run went out through.
   *
   * The field that makes two runs comparable, and the one that says how to read
   * the rest of this object. Under `rotating-residential`, `per_proxy` holds a
   * single row describing **the gateway, not a physical proxy roster**: the exit
   * IPs behind it are chosen per request by the provider and are never visible
   * here, so `configured` is always 1 however many IPs were really used, and
   * `cooling`, `retired`, `saturated` and `capacity` do not apply — nothing in
   * that mode can bench a gateway or ration its slots, so they stay at their
   * inert values rather than reporting a health model that does not exist.
   */
  mode: z.enum(['static', 'rotating-residential']),
  configured: z.number().int().nonnegative(),
  /** Proxies that handled at least one request. */
  used: z.number().int().nonnegative(),
  /** Eligible for rotation at the end of the run. */
  available: z.number().int().nonnegative(),
  /** Configured but never used. */
  untested: z.number().int().nonnegative(),
  /** Waiting out a cooldown. */
  cooling: z.number().int().nonnegative(),
  /** Usable but with every slot taken: capacity pressure, not ill health. */
  saturated: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  /** Proxies taken out of rotation for good as unsuitable exit nodes. */
  retired: z.number().int().nonnegative(),
  /** Leases held across the pool when the summary was taken. */
  total_in_flight: z.number().int().nonnegative(),
  /** Simultaneous proxied requests the usable pool can serve; `null` = unlimited. */
  capacity: z.number().int().nonnegative().nullable(),
  /**
   * Times a job found the whole pool blocked or cooling.
   *
   * Non-zero means the run was limited by the pool rather than by upstream,
   * which is otherwise indistinguishable from a slow platform.
   */
  pool_exhausted: z.number().int().nonnegative(),
  total_failures: z.number().int().nonnegative(),
  /** Historical removals; not included in `configured` or other live gauges. */
  eviction_count: z.number().int().nonnegative(),
  source: ProxySourceSummarySchema.nullable(),
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

  /**
   * `null` when METRICS_BANDWIDTH is off or nothing was measured.
   * Includes direct traffic; on a non-proxied run, `proxies.per_proxy` is empty
   * and therefore cannot be summed to reproduce this top-level total.
   */
  bandwidth: z
    .object({
      /** True count of measured wire round trips: the correct denominator for byte averages. */
      requests: z.number().int().nonnegative(),
      request_bytes: z.number().int().nonnegative(),
      response_bytes: z.number().int().nonnegative(),
      total_bytes: z.number().int().nonnegative(),
      /** `null` rather than 0 when no request was measured. */
      bytes_per_request: z.number().nonnegative().nullable(),
    })
    .nullable(),

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
