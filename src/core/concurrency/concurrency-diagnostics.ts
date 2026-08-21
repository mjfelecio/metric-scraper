import { z } from 'zod';

import { type Logger } from '../logging/logger.js';
import { type ProxyMode } from '../scraper/provider-ports.js';

export const CONCURRENCY_FINDING_CODES = [
  'small_input',
  'admission_limited',
  'proxy_capacity_limited',
  'http_rate_limited',
  'serialized',
  'proxy_capacity_unknown',
] as const;

export const ConcurrencyFindingSchema = z.object({
  code: z.enum(CONCURRENCY_FINDING_CODES),
  severity: z.enum(['info', 'warning']),
});
export type ConcurrencyFinding = z.infer<typeof ConcurrencyFindingSchema>;

export const ConcurrencyCeilingsSchema = z.object({
  configured: z.number().int().nonnegative(),
  input: z.number().int().nonnegative(),
  admission: z.number().int().nonnegative(),
  proxy: z.number().int().nonnegative().nullable(),
  /** `null` when no egress ceiling applies, or the run mixes platforms. */
  http: z.number().int().nonnegative().nullable(),
});
export type ConcurrencyCeilings = z.infer<typeof ConcurrencyCeilingsSchema>;

export interface ConcurrencyDiagnosticInput {
  configuredConcurrency: number;
  acceptedJobs: number;
  resolvedAdmissionBurst: number;
  targetRpm: number;
  meanLatencyMs: number | null;
  admissionWaitMs: number;
  observedConcurrency: number;
  queueDemand: number;
  proxyMode: ProxyMode;
  proxyCapacity: number | null;
  /**
   * The egress ceiling in force for this run's platform, in requests per
   * minute. `null` for a mixed-platform run or when no ceiling is configured.
   */
  httpRpmCeiling?: number | null | undefined;
  /** Outbound requests this run actually made, for measured fan-out. */
  platformHttpRequests?: number | undefined;
  /**
   * Jobs that actually completed — the denominator for fan-out and queue time.
   *
   * Deliberately not `acceptedJobs`: in a multi-cycle session that counts one
   * cycle's input while the request totals accumulate across every cycle, which
   * would multiply the measured fan-out by the cycle count.
   */
  completedJobs?: number | undefined;
  /** Total time jobs spent queued on the egress limiter. */
  httpRateLimitWaitMs?: number | undefined;
}

export interface ConcurrencyDiagnostic {
  achievable: number;
  ceilings: ConcurrencyCeilings;
  findings: ConcurrencyFinding[];
}

/** Pure classification of the concurrency a run could actually have reached. */
export function evaluateConcurrency(input: ConcurrencyDiagnosticInput): ConcurrencyDiagnostic {
  const configured = Math.max(0, Math.floor(input.configuredConcurrency));
  const accepted = Math.max(0, Math.floor(input.acceptedJobs));
  const observed = Math.max(0, Math.floor(input.observedConcurrency));
  const latencyCeiling =
    input.meanLatencyMs === null
      ? 0
      : Math.ceil((Math.max(0, input.targetRpm) * Math.max(0, input.meanLatencyMs)) / 60_000);
  const admission = Math.max(
    observed,
    Math.max(0, Math.floor(input.resolvedAdmissionBurst)),
    latencyCeiling,
  );
  const proxy = input.proxyCapacity === null ? null : Math.max(0, Math.floor(input.proxyCapacity));
  const http = httpCeiling(input);
  const ceilings: ConcurrencyCeilings = { configured, input: accepted, admission, proxy, http };
  const known = [
    configured,
    accepted,
    admission,
    ...(proxy === null ? [] : [proxy]),
    ...(http === null ? [] : [http]),
  ];
  const achievable = Math.min(...known);
  const findings: ConcurrencyFinding[] = [];
  const demanded = Math.min(configured, accepted);

  if (accepted < configured && accepted === achievable) {
    findings.push({ code: 'small_input', severity: 'info' });
  }
  if (input.admissionWaitMs > 0 && admission === achievable && admission < demanded) {
    findings.push({ code: 'admission_limited', severity: 'warning' });
  }
  if (proxy !== null && proxy === achievable && proxy < demanded) {
    findings.push({ code: 'proxy_capacity_limited', severity: 'warning' });
  }
  if (http !== null && http === achievable && http < demanded) {
    findings.push({ code: 'http_rate_limited', severity: 'warning' });
  }
  if (input.proxyMode === 'rotating-residential' && proxy === null) {
    findings.push({ code: 'proxy_capacity_unknown', severity: 'info' });
  }
  if (
    achievable > 0 &&
    observed <= achievable * 0.8 &&
    input.queueDemand > 0 &&
    !findings.some(
      ({ code }) =>
        code === 'admission_limited' ||
        code === 'proxy_capacity_limited' ||
        code === 'http_rate_limited',
    )
  ) {
    findings.push({ code: 'serialized', severity: 'warning' });
  }

  return { achievable, ceilings, findings };
}

/**
 * Concurrency the egress ceiling can actually keep busy, by Little's Law.
 *
 * `in-flight = rate x service time`, where the rate is the ceiling divided by
 * this run's measured fan-out, and service time is mean latency NET of time
 * spent queued on the limiter. Subtracting our own queueing is what keeps this
 * non-circular: including it would let a badly oversubscribed run inflate its
 * own latency and thereby justify the concurrency causing the problem.
 *
 * Anything configured above this is not thoughput, it is queue — jobs holding a
 * slot and a proxy lease while they wait for a token.
 */
function httpCeiling(input: ConcurrencyDiagnosticInput): number | null {
  const rpm = input.httpRpmCeiling;
  if (rpm === null || rpm === undefined || rpm <= 0) return null;
  if (input.meanLatencyMs === null) return null;

  const jobs = Math.max(0, Math.floor(input.completedJobs ?? 0));
  const requests = Math.max(0, input.platformHttpRequests ?? 0);
  if (jobs === 0 || requests === 0) return null;

  const requestsPerJob = requests / jobs;
  const queuedPerJob = Math.max(0, input.httpRateLimitWaitMs ?? 0) / jobs;
  const serviceTimeMs = Math.max(0, input.meanLatencyMs - queuedPerJob);
  if (serviceTimeMs === 0) return null;

  return Math.max(1, Math.ceil((rpm / requestsPerJob) * (serviceTimeMs / 60_000)));
}

export interface ConcurrencyMonitorOptions {
  configuredConcurrency: number;
  acceptedJobs: number;
  proxyMode: ProxyMode;
  logger: Logger;
}

/** Tracks material proxy-capacity crossings without spamming while constrained. */
export class ConcurrencyMonitor {
  private minimumKnownCapacity: number | null = null;
  private limitedBaseline: number | null = null;

  constructor(private readonly options: ConcurrencyMonitorOptions) {}

  observe(proxyCapacity: number | null): void {
    if (proxyCapacity === null) return;
    this.minimumKnownCapacity = Math.min(this.minimumKnownCapacity ?? proxyCapacity, proxyCapacity);
    const demand = Math.min(this.options.configuredConcurrency, this.options.acceptedJobs);
    if (proxyCapacity >= demand) {
      this.limitedBaseline = null;
      return;
    }
    const materialDrop = Math.ceil(demand * 0.2);
    if (this.limitedBaseline === null || this.limitedBaseline - proxyCapacity >= materialDrop) {
      this.limitedBaseline = proxyCapacity;
      this.options.logger.warn(
        {
          configured_concurrency: this.options.configuredConcurrency,
          input_demand: this.options.acceptedJobs,
          known_capacity: proxyCapacity,
          proxy_mode: this.options.proxyMode,
          achievable_concurrency: Math.min(demand, proxyCapacity),
        },
        'proxy capacity limits achievable concurrency',
      );
    }
  }

  get minimumObservedProxyCapacity(): number | null {
    return this.minimumKnownCapacity;
  }
}

export function resolvedAdmissionBurst(targetRpm: number, configuredBurst?: number): number {
  return Math.max(1, configuredBurst ?? Math.ceil(Math.max(0, targetRpm) / 60));
}
