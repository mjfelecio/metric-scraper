import { z } from 'zod';

import { type Logger } from '../logging/logger.js';
import { type ProxyMode } from '../scraper/provider-ports.js';

export const CONCURRENCY_FINDING_CODES = [
  'small_input',
  'admission_limited',
  'proxy_capacity_limited',
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
  const ceilings: ConcurrencyCeilings = { configured, input: accepted, admission, proxy };
  const known = [configured, accepted, admission, ...(proxy === null ? [] : [proxy])];
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
  if (input.proxyMode === 'rotating-residential' && proxy === null) {
    findings.push({ code: 'proxy_capacity_unknown', severity: 'info' });
  }
  if (
    achievable > 0 &&
    observed <= achievable * 0.8 &&
    input.queueDemand > 0 &&
    !findings.some(({ code }) => code === 'admission_limited' || code === 'proxy_capacity_limited')
  ) {
    findings.push({ code: 'serialized', severity: 'warning' });
  }

  return { achievable, ceilings, findings };
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
