import { computed, notComputable, type Maybe } from './computable.js';
import { info, warning, type CapacityFinding } from './findings.js';
import {
  capacityProvenanceFor,
  DAYS_PER_MONTH,
  MINUTES_PER_DAY,
  type CapacityInputs,
} from './inputs.js';
import { simulateCohorts, type CohortDay, type CohortSimulation } from './lifecycle.js';
import type { Provenance } from './provenance.js';
import { evaluateReliability, type ReliabilityModel } from './reliability.js';
import { validateCapacityInputs, type CapacityValidationIssue } from './validation.js';

const MINUTES_PER_SECOND = 60;
const DECIMAL_GB = 1_000_000_000;
const BINARY_GIB = 1_073_741_824;

export interface TrafficSection {
  readonly logicalJobsPerDay: number;
  readonly logicalJobsPerMonth: number;
  readonly logicalJobsInHorizon: number;
  readonly baselineHttpRequestsPerDay: Maybe<number>;
  readonly baselineHttpRequestsPerMonth: Maybe<number>;
  readonly baselineHttpRequestsInHorizon: Maybe<number>;
  readonly adjustedHttpRequestsPerDay: Maybe<number>;
  readonly adjustedHttpRequestsPerMonth: Maybe<number>;
  readonly adjustedHttpRequestsInHorizon: Maybe<number>;
  readonly retriesPerDay: number;
}

export interface BandwidthSection {
  readonly baselineBytesPerDay: Maybe<number>;
  readonly baselineBytesPerMonth: Maybe<number>;
  readonly baselineBytesInHorizon: Maybe<number>;
  readonly baselineGbPerDay: Maybe<number>;
  readonly baselineGbPerMonth: Maybe<number>;
  readonly adjustedBytesPerDay: Maybe<number>;
  readonly adjustedBytesPerMonth: Maybe<number>;
  readonly adjustedBytesInHorizon: Maybe<number>;
  readonly adjustedGbPerDay: Maybe<number>;
  readonly adjustedGbPerMonth: Maybe<number>;
}

export interface ConcurrencySection {
  readonly averageJobs: Maybe<number>;
  readonly peakJobs: Maybe<number>;
  readonly averageHttpRequests: Maybe<number>;
  readonly peakHttpRequests: Maybe<number>;
}

export interface PeakSection {
  readonly jobsPerMinute: number;
  readonly baselineHttpRequestsPerMinute: Maybe<number>;
  readonly adjustedHttpRequestsPerMinute: Maybe<number>;
  readonly source: 'override' | 'multiplier';
}

export interface WorkerSection {
  readonly configuredWorkers: number;
  readonly aggregateJobConcurrency: number;
  readonly aggregateJobTargetPerMinute: number;
  readonly aggregateHttpLimitPerMinute: Maybe<number>;
  readonly requiredByConcurrency: Maybe<number>;
  readonly requiredByJobTarget: Maybe<number>;
  readonly requiredByHttpEgress: Maybe<number>;
  readonly recommendedWorkers: Maybe<number>;
}

export type ProxyConstraintKind = 'job-concurrency' | 'http-rpm' | 'monthly-bandwidth';

export interface ProxyConstraint {
  readonly kind: ProxyConstraintKind;
  readonly rawProxies: Maybe<number>;
}

export interface ProxySection {
  readonly constraints: readonly ProxyConstraint[];
  readonly bindingConstraint: ProxyConstraintKind | null;
  readonly rawRequired: Maybe<number>;
  readonly theoreticalProxies: Maybe<number>;
  readonly recommendedProxies: Maybe<number>;
  readonly configuredPoolSize: number;
  readonly configuredPoolUtilization: Maybe<number>;
  readonly configuredPoolHeadroom: Maybe<number>;
  readonly requestsPerProxyPerDay: Maybe<number>;
  readonly requestsPerProxyPerMonth: Maybe<number>;
  readonly concurrencyPerProxy: Maybe<number>;
}

export interface CostSection {
  readonly billingBandwidthUnitsPerMonth: Maybe<number>;
  readonly bandwidthMonthly: Maybe<number>;
  readonly proxiesMonthly: Maybe<number>;
  readonly fixedPoolMonthly: Maybe<number>;
  readonly totalMonthly: Maybe<number>;
}

export interface GrowthMonth {
  readonly month: number;
  readonly factor: number;
  readonly newSubmissionsPerDay: number;
  readonly logicalJobsPerDay: number;
  readonly adjustedHttpRequestsPerDay: Maybe<number>;
  readonly adjustedGbPerMonth: Maybe<number>;
  readonly recommendedProxies: Maybe<number>;
  readonly estimatedMonthlyCost: Maybe<number>;
}

export interface TimelinePoint extends CohortDay {
  readonly day: number;
  readonly baselineHttpRequests: Maybe<number>;
  readonly adjustedHttpRequests: Maybe<number>;
  readonly adjustedBytes: Maybe<number>;
}

export interface WorkloadSection {
  readonly cohorts: CohortSimulation;
  readonly activeSubmissionsAtRunRate: number;
  readonly polledSubmissionsAtRunRate: number;
  readonly logicalJobsPerDayAtRunRate: number;
  readonly jobsPerMinuteAtRunRate: number;
  readonly pollingPlateauDay: number | null;
  readonly activeLifecyclePlateauDay: number | null;
}

export interface CapacitySimulationResult {
  readonly inputs: CapacityInputs;
  readonly valid: boolean;
  readonly validation: {
    readonly valid: boolean;
    readonly issues: readonly CapacityValidationIssue[];
  };
  readonly workload: WorkloadSection;
  readonly reliability: ReliabilityModel;
  readonly traffic: TrafficSection;
  readonly bandwidth: BandwidthSection;
  readonly concurrency: ConcurrencySection;
  readonly workers: WorkerSection;
  /** Alias retained for callers that use the singular result-group label. */
  readonly worker: WorkerSection;
  readonly proxy: ProxySection;
  readonly cost: CostSection;
  readonly growth: readonly GrowthMonth[];
  readonly peak: PeakSection;
  readonly timeline: readonly TimelinePoint[];
  readonly provenance: Readonly<Record<string, Provenance>>;
  readonly findings: readonly CapacityFinding[];
}

/**
 * Public, deterministic orchestration entry point. It performs no DOM, network,
 * filesystem, clock, or environment access.
 */
export function simulateCapacity(input: CapacityInputs): CapacitySimulationResult {
  const issues = validateCapacityInputs(input);
  const cohorts = simulateCohorts({
    newSubmissionsPerDay: input.newSubmissionsPerDay,
    stages: input.stages,
    horizonDays: input.horizonDays,
  });
  const reliability = evaluateReliability(input.reliability);
  const runRateJobs = input.newSubmissionsPerDay * cohorts.profile.pollsPerSubmissionTotal;
  const runRateJobsPerMinute = runRateJobs / MINUTES_PER_DAY;
  const activeAtRunRate = input.newSubmissionsPerDay * cohorts.profile.lifecycleDays;
  const polledAtRunRate = input.newSubmissionsPerDay * cohorts.profile.polledLifecycleDays;

  const traffic = calculateTraffic(
    runRateJobs,
    cohorts.totalScrapeJobs,
    input.requestsPerJob,
    reliability,
  );
  const bandwidth = calculateBandwidth(traffic, input.bytesPerHttpRequest);
  const peak = calculatePeak(input, runRateJobsPerMinute, reliability);
  const concurrency = calculateConcurrency(input, runRateJobsPerMinute, peak);
  const workers = calculateWorkers(input, runRateJobsPerMinute, traffic, concurrency);
  const proxy = calculateProxy(input, traffic, bandwidth, concurrency);
  const cost = calculateCost(input, traffic, bandwidth, reliability, proxy);
  const findings = buildFindings(
    input,
    cohorts,
    traffic,
    concurrency,
    workers,
    proxy,
    cost,
    reliability,
  );
  const growth = calculateGrowth(input, traffic, bandwidth, proxy, cost);
  const timeline = cohorts.days.map((day) => timelinePoint(day, input, reliability));

  const workload: WorkloadSection = {
    cohorts,
    activeSubmissionsAtRunRate: activeAtRunRate,
    polledSubmissionsAtRunRate: polledAtRunRate,
    logicalJobsPerDayAtRunRate: runRateJobs,
    jobsPerMinuteAtRunRate: runRateJobsPerMinute,
    pollingPlateauDay:
      cohorts.jobsPlateauDayIndex === null ? null : cohorts.jobsPlateauDayIndex + 1,
    activeLifecyclePlateauDay:
      cohorts.activePlateauDayIndex === null ? null : cohorts.activePlateauDayIndex + 1,
  };

  return {
    inputs: input,
    valid: issues.length === 0,
    validation: { valid: issues.length === 0, issues },
    workload,
    reliability,
    traffic,
    bandwidth,
    concurrency,
    workers,
    worker: workers,
    proxy,
    cost,
    growth,
    peak,
    timeline,
    provenance: capacityProvenanceFor(input.platform),
    findings,
  };
}

function calculateTraffic(
  jobsPerDay: number,
  horizonJobs: number,
  requestsPerJob: number | null,
  reliability: ReliabilityModel,
): TrafficSection {
  const baselineDay = multiplyMaybe(requestsPerJob, jobsPerDay, 'requestsPerJob');
  const baselineMonth = mapNumber(baselineDay, (value) => value * DAYS_PER_MONTH);
  const baselineHorizon = multiplyMaybe(requestsPerJob, horizonJobs, 'requestsPerJob');
  return {
    logicalJobsPerDay: jobsPerDay,
    logicalJobsPerMonth: jobsPerDay * DAYS_PER_MONTH,
    logicalJobsInHorizon: horizonJobs,
    baselineHttpRequestsPerDay: baselineDay,
    baselineHttpRequestsPerMonth: baselineMonth,
    baselineHttpRequestsInHorizon: baselineHorizon,
    adjustedHttpRequestsPerDay: mapNumber(
      baselineDay,
      (value) => value * reliability.attemptAmplification,
    ),
    adjustedHttpRequestsPerMonth: mapNumber(
      baselineMonth,
      (value) => value * reliability.attemptAmplification,
    ),
    adjustedHttpRequestsInHorizon: mapNumber(
      baselineHorizon,
      (value) => value * reliability.attemptAmplification,
    ),
    retriesPerDay: jobsPerDay * (reliability.attemptAmplification - 1),
  };
}

function calculateBandwidth(
  traffic: TrafficSection,
  bytesPerRequest: number | null,
): BandwidthSection {
  const baselineDay = multiplyMaybeValue(
    traffic.baselineHttpRequestsPerDay,
    bytesPerRequest,
    'bytesPerHttpRequest',
  );
  const baselineMonth = multiplyMaybeValue(
    traffic.baselineHttpRequestsPerMonth,
    bytesPerRequest,
    'bytesPerHttpRequest',
  );
  const baselineHorizon = multiplyMaybeValue(
    traffic.baselineHttpRequestsInHorizon,
    bytesPerRequest,
    'bytesPerHttpRequest',
  );
  const adjustedDay = multiplyMaybeValue(
    traffic.adjustedHttpRequestsPerDay,
    bytesPerRequest,
    'bytesPerHttpRequest',
  );
  const adjustedMonth = multiplyMaybeValue(
    traffic.adjustedHttpRequestsPerMonth,
    bytesPerRequest,
    'bytesPerHttpRequest',
  );
  const adjustedHorizon = multiplyMaybeValue(
    traffic.adjustedHttpRequestsInHorizon,
    bytesPerRequest,
    'bytesPerHttpRequest',
  );
  return {
    baselineBytesPerDay: baselineDay,
    baselineBytesPerMonth: baselineMonth,
    baselineBytesInHorizon: baselineHorizon,
    baselineGbPerDay: mapNumber(baselineDay, (value) => value / DECIMAL_GB),
    baselineGbPerMonth: mapNumber(baselineMonth, (value) => value / DECIMAL_GB),
    adjustedBytesPerDay: adjustedDay,
    adjustedBytesPerMonth: adjustedMonth,
    adjustedBytesInHorizon: adjustedHorizon,
    adjustedGbPerDay: mapNumber(adjustedDay, (value) => value / DECIMAL_GB),
    adjustedGbPerMonth: mapNumber(adjustedMonth, (value) => value / DECIMAL_GB),
  };
}

function calculatePeak(
  input: CapacityInputs,
  jobsPerMinute: number,
  reliability: ReliabilityModel,
): PeakSection {
  const hasOverride = input.capacity.peakJobsPerMinuteOverride !== null;
  const peakJobs = hasOverride
    ? (input.capacity.peakJobsPerMinuteOverride ?? 0)
    : jobsPerMinute * input.capacity.peakMultiplier;
  const baselineHttp = multiplyMaybe(input.requestsPerJob, peakJobs, 'requestsPerJob');
  return {
    jobsPerMinute: peakJobs,
    baselineHttpRequestsPerMinute: baselineHttp,
    adjustedHttpRequestsPerMinute: mapNumber(
      baselineHttp,
      (value) => value * reliability.attemptAmplification,
    ),
    source: hasOverride ? 'override' : 'multiplier',
  };
}

function calculateConcurrency(
  input: CapacityInputs,
  jobsPerMinute: number,
  peak: PeakSection,
): ConcurrencySection {
  const averageJobs = littleLaw(jobsPerMinute, input.meanJobLatencyMs, 'meanJobLatencyMs');
  const peakJobs = littleLaw(peak.jobsPerMinute, input.p95JobLatencyMs, 'p95JobLatencyMs');
  const averageHttpRpm = multiplyMaybe(
    input.requestsPerJob,
    jobsPerMinute * evaluateReliability(input.reliability).attemptAmplification,
    'requestsPerJob',
  );
  return {
    averageJobs,
    peakJobs,
    averageHttpRequests: littleLawMaybe(
      averageHttpRpm,
      input.meanHttpLatencyMs,
      'meanHttpLatencyMs',
    ),
    peakHttpRequests: littleLawMaybe(
      peak.adjustedHttpRequestsPerMinute,
      input.p95HttpLatencyMs,
      'p95HttpLatencyMs',
    ),
  };
}

function calculateWorkers(
  input: CapacityInputs,
  jobsPerMinute: number,
  traffic: TrafficSection,
  concurrency: ConcurrencySection,
): WorkerSection {
  const workers = input.capacity.workers;
  const requiredByConcurrency = mapNumber(concurrency.averageJobs, (value) =>
    Math.ceil(value / input.capacity.concurrencyPerWorker),
  );
  const requiredByJobTarget =
    input.capacity.targetJobsPerMinute === 0
      ? jobsPerMinute === 0
        ? computed(0)
        : notComputable('job target is zero', ['capacity.targetJobsPerMinute'])
      : computed(Math.ceil(jobsPerMinute / input.capacity.targetJobsPerMinute));
  const adjustedRpm = mapNumber(
    traffic.adjustedHttpRequestsPerDay,
    (value) => value / MINUTES_PER_DAY,
  );
  const requiredByHttpEgress =
    input.capacity.httpRpmPerHost === null
      ? notComputable('HTTP egress limit is not set', ['capacity.httpRpmPerHost'])
      : mapNumber(adjustedRpm, (value) => Math.ceil(value / input.capacity.httpRpmPerHost!));
  const known = [requiredByConcurrency, requiredByJobTarget, requiredByHttpEgress]
    .filter((value): value is { computable: true; value: number } => value.computable)
    .map((value) => value.value);
  return {
    configuredWorkers: workers,
    aggregateJobConcurrency: workers * input.capacity.concurrencyPerWorker,
    aggregateJobTargetPerMinute: workers * input.capacity.targetJobsPerMinute,
    aggregateHttpLimitPerMinute:
      input.capacity.httpRpmPerHost === null
        ? notComputable('HTTP egress limit is not set', ['capacity.httpRpmPerHost'])
        : computed(workers * input.capacity.httpRpmPerHost),
    requiredByConcurrency,
    requiredByJobTarget,
    requiredByHttpEgress,
    recommendedWorkers:
      known.length === 0
        ? notComputable('no worker sizing constraint can be computed')
        : computed(Math.max(...known)),
  };
}

function calculateProxy(
  input: CapacityInputs,
  traffic: TrafficSection,
  bandwidth: BandwidthSection,
  concurrency: ConcurrencySection,
): ProxySection {
  const limits = input.capacity.proxyLimits;
  const concurrencyConstraint: ProxyConstraint = {
    kind: 'job-concurrency',
    rawProxies: divideMaybe(
      concurrency.averageJobs,
      limits.maxConcurrentPerProxy,
      'capacity.proxyLimits.maxConcurrentPerProxy',
    ),
  };
  const rpm = mapNumber(traffic.adjustedHttpRequestsPerDay, (value) => value / MINUTES_PER_DAY);
  const rpmConstraint: ProxyConstraint = {
    kind: 'http-rpm',
    rawProxies: divideMaybe(
      rpm,
      limits.maxRequestsPerMinutePerProxy,
      'capacity.proxyLimits.maxRequestsPerMinutePerProxy',
    ),
  };
  const bandwidthConstraint: ProxyConstraint = {
    kind: 'monthly-bandwidth',
    rawProxies: divideMaybe(
      bandwidth.adjustedBytesPerMonth,
      limits.maxBytesPerMonthPerProxy,
      'capacity.proxyLimits.maxBytesPerMonthPerProxy',
    ),
  };
  const constraints = [concurrencyConstraint, rpmConstraint, bandwidthConstraint];
  const available = constraints.filter(
    (
      constraint,
    ): constraint is ProxyConstraint & { rawProxies: { computable: true; value: number } } =>
      constraint.rawProxies.computable,
  );
  const binding = available.reduce<(typeof available)[number] | null>(
    (best, constraint) =>
      best === null || constraint.rawProxies.value > best.rawProxies.value ? constraint : best,
    null,
  );
  const rawRequired =
    binding === null
      ? notComputable('no per-proxy capacity limit is available', [
          'capacity.proxyLimits.maxConcurrentPerProxy',
          'capacity.proxyLimits.maxRequestsPerMinutePerProxy',
          'capacity.proxyLimits.maxBytesPerMonthPerProxy',
        ])
      : computed(binding.rawProxies.value);
  const theoretical = mapNumber(rawRequired, Math.ceil);
  const recommended = mapNumber(rawRequired, (value) =>
    Math.ceil(value * (1 + input.capacity.safetyMargin)),
  );
  const configured = input.capacity.proxyPoolSize;
  return {
    constraints,
    bindingConstraint: binding?.kind ?? null,
    rawRequired,
    theoreticalProxies: theoretical,
    recommendedProxies: recommended,
    configuredPoolSize: configured,
    configuredPoolUtilization:
      configured === 0
        ? notComputable('configured proxy pool is empty', ['capacity.proxyPoolSize'])
        : mapNumber(rawRequired, (value) => value / configured),
    configuredPoolHeadroom: mapNumber(recommended, (value) => configured - value),
    requestsPerProxyPerDay:
      configured === 0
        ? notComputable('configured proxy pool is empty', ['capacity.proxyPoolSize'])
        : mapNumber(traffic.adjustedHttpRequestsPerDay, (value) => value / configured),
    requestsPerProxyPerMonth:
      configured === 0
        ? notComputable('configured proxy pool is empty', ['capacity.proxyPoolSize'])
        : mapNumber(traffic.adjustedHttpRequestsPerMonth, (value) => value / configured),
    concurrencyPerProxy:
      configured === 0
        ? notComputable('configured proxy pool is empty', ['capacity.proxyPoolSize'])
        : mapNumber(concurrency.averageJobs, (value) => value / configured),
  };
}

function calculateCost(
  input: CapacityInputs,
  traffic: TrafficSection,
  bandwidth: BandwidthSection,
  reliability: ReliabilityModel,
  proxy: ProxySection,
): CostSection {
  const divisor = input.pricing.billingUnit === 'GB' ? DECIMAL_GB : BINARY_GIB;
  const billableBytes = input.pricing.billsFailedAttempts
    ? bandwidth.adjustedBytesPerMonth
    : multiplyMaybeValue(
        traffic.baselineHttpRequestsPerMonth,
        input.bytesPerHttpRequest,
        'bytesPerHttpRequest',
        reliability.jobSuccessRate,
      );
  const billingUnits = mapNumber(billableBytes, (value) => value / divisor);
  const bandwidthMonthly = multiplyPrice(
    billingUnits,
    input.pricing.pricePerGb,
    'pricing.pricePerGb',
  );
  const proxiesMonthly = multiplyPrice(
    proxy.recommendedProxies,
    input.pricing.fixedMonthlyPerProxy,
    'pricing.fixedMonthlyPerProxy',
  );
  const fixedPoolMonthly =
    input.pricing.fixedMonthlyPool === null
      ? notComputable('fixed pool price is not set', ['pricing.fixedMonthlyPool'])
      : computed(input.pricing.fixedMonthlyPool);
  const all = [bandwidthMonthly, proxiesMonthly, fixedPoolMonthly];
  const unavailable = all.find((value) => !value.computable);
  return {
    billingBandwidthUnitsPerMonth: billingUnits,
    bandwidthMonthly,
    proxiesMonthly,
    fixedPoolMonthly,
    totalMonthly:
      unavailable === undefined
        ? computed(all.reduce((sum, value) => sum + (value.computable ? value.value : 0), 0))
        : notComputable('one or more monthly prices are not set', unavailable.missing),
  };
}

function calculateGrowth(
  input: CapacityInputs,
  traffic: TrafficSection,
  bandwidth: BandwidthSection,
  proxy: ProxySection,
  cost: CostSection,
): GrowthMonth[] {
  const rate = input.growth.enabled ? input.growth.monthlyGrowthRate : 0;
  const months = Math.max(1, Math.floor(input.growth.months));
  return Array.from({ length: months }, (_, index) => {
    const factor = (1 + rate) ** index;
    const recommendedProxies = mapNumber(proxy.rawRequired, (value) =>
      Math.ceil(value * factor * (1 + input.capacity.safetyMargin)),
    );
    const bandwidthCost = mapNumber(cost.bandwidthMonthly, (value) => value * factor);
    const proxyCost = multiplyPrice(
      recommendedProxies,
      input.pricing.fixedMonthlyPerProxy,
      'pricing.fixedMonthlyPerProxy',
    );
    const fixedPoolCost =
      input.pricing.fixedMonthlyPool === null
        ? notComputable('fixed pool price is not set', ['pricing.fixedMonthlyPool'])
        : computed(input.pricing.fixedMonthlyPool);
    return {
      month: index + 1,
      factor,
      newSubmissionsPerDay: input.newSubmissionsPerDay * factor,
      logicalJobsPerDay: traffic.logicalJobsPerDay * factor,
      adjustedHttpRequestsPerDay: mapNumber(
        traffic.adjustedHttpRequestsPerDay,
        (value) => value * factor,
      ),
      adjustedGbPerMonth: mapNumber(bandwidth.adjustedGbPerMonth, (value) => value * factor),
      recommendedProxies,
      estimatedMonthlyCost: sumMaybes([bandwidthCost, proxyCost, fixedPoolCost]),
    };
  });
}

function sumMaybes(values: readonly Maybe<number>[]): Maybe<number> {
  const unavailable = values.find((value) => !value.computable);
  if (unavailable !== undefined && !unavailable.computable) return unavailable;
  return computed(values.reduce((sum, value) => sum + (value.computable ? value.value : 0), 0));
}

function timelinePoint(
  day: CohortDay,
  input: CapacityInputs,
  reliability: ReliabilityModel,
): TimelinePoint {
  const baseline = multiplyMaybe(input.requestsPerJob, day.scrapeJobs, 'requestsPerJob');
  const adjusted = mapNumber(baseline, (value) => value * reliability.attemptAmplification);
  return {
    ...day,
    day: day.dayIndex + 1,
    baselineHttpRequests: baseline,
    adjustedHttpRequests: adjusted,
    adjustedBytes: multiplyMaybeValue(adjusted, input.bytesPerHttpRequest, 'bytesPerHttpRequest'),
  };
}

function buildFindings(
  input: CapacityInputs,
  cohorts: CohortSimulation,
  traffic: TrafficSection,
  concurrency: ConcurrencySection,
  workers: WorkerSection,
  proxy: ProxySection,
  cost: CostSection,
  reliability: ReliabilityModel,
): CapacityFinding[] {
  const findings = [...cohorts.findings, ...reliability.findings];
  if (!concurrency.averageJobs.computable || !concurrency.peakJobs.computable) {
    findings.push(
      warning('latency_unknown', 'job latency is missing, so job concurrency is unavailable'),
    );
  }
  if (
    concurrency.averageJobs.computable &&
    concurrency.averageJobs.value > workers.aggregateJobConcurrency
  ) {
    findings.push(
      warning(
        'concurrency_below_demand',
        `${String(workers.aggregateJobConcurrency)} configured job slots are below ${concurrency.averageJobs.value.toFixed(1)} average demand`,
      ),
    );
  }
  const jobsRpm = traffic.logicalJobsPerDay / MINUTES_PER_DAY;
  if (jobsRpm > workers.aggregateJobTargetPerMinute) {
    findings.push(
      warning('admission_below_demand', 'aggregate job admission target is below demand'),
    );
  } else if (workers.aggregateJobTargetPerMinute > jobsRpm * 2) {
    findings.push(
      info('target_above_demand', 'configured job target is more than twice average demand'),
    );
  }
  const httpRpm = mapNumber(traffic.adjustedHttpRequestsPerDay, (value) => value / MINUTES_PER_DAY);
  if (
    httpRpm.computable &&
    workers.aggregateHttpLimitPerMinute.computable &&
    httpRpm.value > workers.aggregateHttpLimitPerMinute.value
  ) {
    findings.push(warning('egress_below_demand', 'aggregate HTTP egress limit is below demand'));
  }
  if (!proxy.rawRequired.computable) {
    findings.push(warning('proxy_limits_unknown', proxy.rawRequired.reason));
  }
  if (
    proxy.recommendedProxies.computable &&
    proxy.recommendedProxies.value > input.capacity.proxyPoolSize
  ) {
    findings.push(
      warning('proxy_pool_below_demand', 'configured proxy pool is below the recommendation'),
    );
  }
  if (input.capacity.proxyLimits.earnedConcurrencyPerProxy !== null) {
    const earned = input.capacity.proxyLimits.earnedConcurrencyPerProxy;
    const configured = input.capacity.proxyLimits.maxConcurrentPerProxy;
    if (configured !== null && earned < configured) {
      findings.push(
        info(
          'proxy_cold_start_gap',
          `the measured warm-pool capacity is ${earned.toFixed(1)} of ${configured.toFixed(1)} configured slots per proxy`,
        ),
      );
    }
  }
  if (!cost.totalMonthly.computable) {
    findings.push(
      info('pricing_unknown', 'monthly total remains unavailable until every price is explicit'),
    );
  }
  return findings;
}

function littleLaw(ratePerMinute: number, latencyMs: number | null, path: string): Maybe<number> {
  if (latencyMs === null) return notComputable(`${path} is not set`, [path]);
  return computed((ratePerMinute / MINUTES_PER_SECOND) * (latencyMs / 1_000));
}

function littleLawMaybe(
  rate: Maybe<number>,
  latencyMs: number | null,
  path: string,
): Maybe<number> {
  if (!rate.computable) return rate;
  return littleLaw(rate.value, latencyMs, path);
}

function multiplyMaybe(value: number | null, factor: number, path: string): Maybe<number> {
  return value === null ? notComputable(`${path} is not set`, [path]) : computed(value * factor);
}

function multiplyMaybeValue(
  value: Maybe<number>,
  factor: number | null,
  path: string,
  extraFactor = 1,
): Maybe<number> {
  if (!value.computable) return value;
  return factor === null
    ? notComputable(`${path} is not set`, [path])
    : computed(value.value * factor * extraFactor);
}

function multiplyPrice(value: Maybe<number>, price: number | null, path: string): Maybe<number> {
  if (!value.computable) return value;
  return price === null
    ? notComputable(`${path} is not set`, [path])
    : computed(value.value * price);
}

function divideMaybe(value: Maybe<number>, divisor: number | null, path: string): Maybe<number> {
  if (!value.computable) return value;
  return divisor === null
    ? notComputable(`${path} is not set`, [path])
    : computed(value.value / divisor);
}

function mapNumber(value: Maybe<number>, project: (value: number) => number): Maybe<number> {
  return value.computable ? computed(project(value.value)) : value;
}
