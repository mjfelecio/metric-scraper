/**
 * Conditions the model wants to point at, rather than leave in the numbers.
 *
 * Modelled on `ConcurrencyFinding` in `src/core/concurrency/concurrency-diagnostics.ts`,
 * including its deliberate two-level severity: the live diagnostics and this
 * planning model should not disagree about what "warning" means. No zod here —
 * unlike the run summary these never cross a serialization boundary, and the
 * capacity engine is browser-bundled code that has no other reason to pull the
 * schema library in.
 */

export const CAPACITY_FINDING_CODES = [
  'no_enabled_stages',
  'no_submissions',
  'horizon_shorter_than_lifecycle',
  'dormant_stage_present',
  'sparse_polling',
  'latency_unknown',
  'egress_below_demand',
  'admission_below_demand',
  'concurrency_below_demand',
  'proxy_pool_below_demand',
  'proxy_limits_unknown',
  'proxy_oversubscribed',
  'proxy_cold_start_gap',
  'cycle_burst_exceeds_interval',
  'retry_amplification_high',
  'pricing_unknown',
  'target_below_demand',
  'target_above_demand',
  'workers_exceed_process_limits',
] as const;

export type CapacityFindingCode = (typeof CAPACITY_FINDING_CODES)[number];

export interface CapacityFinding {
  readonly code: CapacityFindingCode;
  readonly severity: 'info' | 'warning';
  /** Numbers already substituted, so the UI never re-derives them. */
  readonly detail: string;
}

export function info(code: CapacityFindingCode, detail: string): CapacityFinding {
  return { code, severity: 'info', detail };
}

export function warning(code: CapacityFindingCode, detail: string): CapacityFinding {
  return { code, severity: 'warning', detail };
}
