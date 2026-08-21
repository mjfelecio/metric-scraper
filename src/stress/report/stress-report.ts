import { type LatencySummary, type ProxySummary } from '../../core/models/run-summary.js';
import { type LoadGeneratorResult, type PhaseResult } from '../load-generator/load-generator.js';
import { ACCEPTANCE_DURATION_MS } from '../load-generator/profiles.js';

export type FindingKind =
  | 'throughput_below_target'
  | 'retry_storm'
  | 'proxy_exhaustion'
  | 'excessive_rate_limiting'
  | 'unbounded_queue_growth'
  | 'memory_growth'
  | 'fatal_error';

export interface CollapseFinding {
  kind: FindingKind;
  /** `fail` gates the verdict; `warn` is reported but does not by itself fail the run. */
  severity: 'fail' | 'warn';
  message: string;
}

export interface StressReportThresholds {
  /** `retries.total_retries / totals.requests` above this is a retry storm. */
  retryStormRatio: number;
  /** `status_breakdown.rate_limited / totals.requests` above this is excessive. */
  rateLimitedRatio: number;
  /** `(cooling + retired) / configured` above this is proxy degradation. */
  proxyDegradedRatio: number;
  /** Mean queued in the last 20% of samples vs. the first 20%, above this ratio. */
  queueGrowthRatio: number;
  /**
   * A sample counts toward a "sustained" window if its rate is at least
   * `targetRpm * sustainedTolerance`, not the raw target.
   *
   * `ThroughputTimeline.sustained()` (pre-existing production code, also
   * used by `scrape-session.ts`) compares each sample's rate against the
   * target with a strict `>=`. When the achieved rate genuinely hovers right
   * at the target -- exactly the case a `--target-rpm 500` run against a
   * healthy system produces -- ordinary `setInterval` timer jitter (a few ms
   * per tick) is enough to make individual samples read a hair under target
   * (499 vs 500), which breaks an otherwise-real multi-second streak into
   * isolated few-sample fragments. Measured directly: a verified-healthy
   * 100%-success run pacing at exactly 500rpm produced samples of
   * 499/500/501/499/500/... and a `sustained()` window of ~3s out of a
   * 15s run, despite `throughput.requests_per_minute` reading 515.9 for the
   * whole run. A small tolerance absorbs that noise without weakening the
   * bar's intent: a system that is not actually keeping up won't cluster
   * its per-sample rate this tightly around the target to begin with.
   */
  sustainedTolerance: number;
}

export const DEFAULT_STRESS_REPORT_THRESHOLDS: StressReportThresholds = {
  retryStormRatio: 0.5,
  rateLimitedRatio: 0.05,
  proxyDegradedRatio: 0.5,
  queueGrowthRatio: 3,
  sustainedTolerance: 0.97,
};

export interface StressReportPhase {
  name: string;
  targetRpm: number;
  durationMs: number;
  requests: number;
  successes: number;
  failures: number;
  successRate: number;
}

export interface StressReport {
  profile: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** The steady/final phase's configured rate -- the number a verdict is judged against. */
  targetRpm: number;
  /** `null` when this profile has no hard sustained-duration requirement (only `acceptance` does by default). */
  requiredSustainedMs: number | null;
  /** Longest contiguous stretch at/above `targetRpm`, across the whole run's shared timeline. */
  sustainedWindowMs: number;
  totals: {
    submitted: number;
    completed: number;
    successes: number;
    failures: number;
    successRate: number;
    retries: number;
    platformHttpRequests: number;
  };
  /** The steady/final phase's own achieved rate. */
  actualThroughputRpm: number;
  /** The steady/final phase's own latency percentiles -- see module doc for why this isn't cross-phase-averaged. */
  latency: LatencySummary;
  /** The steady/final phase's own proxy pool state -- the most current snapshot. */
  proxies: ProxySummary;
  bandwidth: { requests: number; totalBytes: number; bytesPerRequest: number | null } | null;
  peakQueueDepth: number;
  peakMemoryRssBytes: number | null;
  memoryGrowthRatio: number | null;
  phases: StressReportPhase[];
  findings: CollapseFinding[];
  verdict: 'PASS' | 'FAIL';
}

export interface BuildStressReportOptions {
  /** Overrides the sustained-duration requirement inferred from `plan.profile`. */
  requiredSustainedMs?: number | null | undefined;
  thresholds?: Partial<StressReportThresholds> | undefined;
}

/**
 * Turns raw `LoadGeneratorResult` phases into a pass/fail verdict.
 *
 * Per-count metrics (requests, successes, retries, bytes) are safe to sum
 * across phases and are summed for `totals`/`bandwidth`. Latency percentiles
 * are NOT: this codebase's own summaries state "an average of p95s is not a
 * p95" (see `format-session-summary.ts`), and there is no seam here to
 * recompute one from raw per-job samples without a second production change.
 * So `latency` (and `proxies`, which is a point-in-time snapshot by nature)
 * report the steady/final phase's own numbers, labelled as such rather than
 * quietly presented as a whole-run figure.
 */
export function buildStressReport(
  result: LoadGeneratorResult,
  options: BuildStressReportOptions = {},
): StressReport {
  const thresholds = { ...DEFAULT_STRESS_REPORT_THRESHOLDS, ...options.thresholds };
  const finalPhase = result.phases[result.phases.length - 1];
  const requiredSustainedMs =
    options.requiredSustainedMs !== undefined
      ? options.requiredSustainedMs
      : result.plan.profile === 'acceptance'
        ? // The spec's own 10 minutes by default, but scaled to whatever this
          // phase was actually configured to run for -- a `--duration`
          // override (e.g. a quick dev smoke check) must not silently judge
          // a 15-second run against a 10-minute requirement it was never
          // going to be given the time to meet.
          (finalPhase?.phase.durationMs ?? ACCEPTANCE_DURATION_MS)
        : null;
  const targetRpm = finalPhase?.phase.targetRpm ?? 0;

  const totals = result.phases.reduce(
    (sum, phase) => ({
      submitted: sum.submitted + phase.summary.totals.requests,
      completed: sum.completed + phase.summary.totals.requests,
      successes: sum.successes + phase.summary.totals.successes,
      failures: sum.failures + phase.summary.totals.failures,
      retries: sum.retries + phase.summary.retries.total_retries,
      platformHttpRequests: sum.platformHttpRequests + phase.summary.totals.platform_http_requests,
      rateLimited: sum.rateLimited + (phase.summary.status_breakdown.rate_limited ?? 0),
    }),
    {
      submitted: 0,
      completed: 0,
      successes: 0,
      failures: 0,
      retries: 0,
      platformHttpRequests: 0,
      rateLimited: 0,
    },
  );

  const bandwidth = result.phases.reduce<{
    requests: number;
    requestBytes: number;
    responseBytes: number;
  } | null>((sum, phase) => {
    if (phase.summary.bandwidth === null) return sum;
    const base = sum ?? { requests: 0, requestBytes: 0, responseBytes: 0 };
    return {
      requests: base.requests + phase.summary.bandwidth.requests,
      requestBytes: base.requestBytes + phase.summary.bandwidth.request_bytes,
      responseBytes: base.responseBytes + phase.summary.bandwidth.response_bytes,
    };
  }, null);

  const sustainedWindowMs =
    targetRpm > 0
      ? result.timeline.sustained(targetRpm * thresholds.sustainedTolerance).windowMs
      : result.finishedAt.getTime() - result.startedAt.getTime();

  const findings: CollapseFinding[] = [
    ...throughputFindings(targetRpm, requiredSustainedMs, sustainedWindowMs),
    ...retryStormFindings(totals, thresholds),
    ...rateLimitFindings(totals, thresholds),
    ...proxyExhaustionFindings(finalPhase, thresholds),
    ...queueGrowthFindings(result, thresholds),
    ...memoryGrowthFindings(result),
    ...fatalErrorFindings(result.phases),
  ];

  const verdict: 'PASS' | 'FAIL' = findings.some((finding) => finding.severity === 'fail')
    ? 'FAIL'
    : 'PASS';

  return {
    profile: result.plan.profile,
    startedAt: result.startedAt.toISOString(),
    finishedAt: result.finishedAt.toISOString(),
    durationMs: result.finishedAt.getTime() - result.startedAt.getTime(),
    targetRpm,
    requiredSustainedMs,
    sustainedWindowMs,
    totals: {
      submitted: totals.submitted,
      completed: totals.completed,
      successes: totals.successes,
      failures: totals.failures,
      successRate: totals.submitted > 0 ? totals.successes / totals.submitted : 0,
      retries: totals.retries,
      platformHttpRequests: totals.platformHttpRequests,
    },
    actualThroughputRpm: finalPhase?.summary.throughput.requests_per_minute ?? 0,
    latency: finalPhase?.summary.latency ?? emptyLatency(),
    proxies: finalPhase?.summary.proxies ?? emptyProxies(),
    bandwidth:
      bandwidth === null
        ? null
        : {
            requests: bandwidth.requests,
            totalBytes: bandwidth.requestBytes + bandwidth.responseBytes,
            bytesPerRequest:
              bandwidth.requests > 0
                ? (bandwidth.requestBytes + bandwidth.responseBytes) / bandwidth.requests
                : null,
          },
    peakQueueDepth: result.queueSamples.reduce((max, sample) => Math.max(max, sample.queued), 0),
    peakMemoryRssBytes:
      result.memorySamples.length > 0
        ? Math.max(...result.memorySamples.map((sample) => sample.rssBytes))
        : null,
    memoryGrowthRatio: memoryGrowthRatio(result),
    phases: result.phases.map(toReportPhase),
    findings,
    verdict,
  };
}

function throughputFindings(
  targetRpm: number,
  requiredSustainedMs: number | null,
  sustainedWindowMs: number,
): CollapseFinding[] {
  if (requiredSustainedMs === null || targetRpm <= 0) return [];
  if (sustainedWindowMs >= requiredSustainedMs) return [];
  return [
    {
      kind: 'throughput_below_target',
      severity: 'fail',
      message:
        `did not sustain ${targetRpm} req/min for the required ${Math.round(requiredSustainedMs / 1000)}s ` +
        `(longest contiguous window at/above target: ${Math.round(sustainedWindowMs / 1000)}s)`,
    },
  ];
}

function retryStormFindings(
  totals: { retries: number; submitted: number },
  thresholds: StressReportThresholds,
): CollapseFinding[] {
  if (totals.submitted === 0) return [];
  const ratio = totals.retries / totals.submitted;
  if (ratio <= thresholds.retryStormRatio) return [];
  return [
    {
      kind: 'retry_storm',
      severity: 'fail',
      message: `${totals.retries} retries across ${totals.submitted} jobs (${(ratio * 100).toFixed(1)}%, threshold ${(thresholds.retryStormRatio * 100).toFixed(0)}%)`,
    },
  ];
}

function rateLimitFindings(
  totals: { rateLimited: number; submitted: number },
  thresholds: StressReportThresholds,
): CollapseFinding[] {
  if (totals.submitted === 0) return [];
  const ratio = totals.rateLimited / totals.submitted;
  if (ratio <= thresholds.rateLimitedRatio) return [];
  return [
    {
      kind: 'excessive_rate_limiting',
      severity: 'fail',
      message: `${totals.rateLimited} rate-limited responses across ${totals.submitted} jobs (${(ratio * 100).toFixed(1)}%, threshold ${(thresholds.rateLimitedRatio * 100).toFixed(0)}%)`,
    },
  ];
}

function proxyExhaustionFindings(
  finalPhase: PhaseResult | undefined,
  thresholds: StressReportThresholds,
): CollapseFinding[] {
  if (finalPhase === undefined) return [];
  const proxies = finalPhase.summary.proxies;
  const findings: CollapseFinding[] = [];
  if (proxies.pool_exhausted > 0) {
    findings.push({
      kind: 'proxy_exhaustion',
      severity: 'fail',
      message: `pool_exhausted=${proxies.pool_exhausted}: at least one job found every proxy out at once`,
    });
  }
  if (proxies.configured > 0) {
    const degraded = (proxies.cooling + proxies.retired) / proxies.configured;
    if (degraded > thresholds.proxyDegradedRatio) {
      findings.push({
        kind: 'proxy_exhaustion',
        severity: 'fail',
        message: `${proxies.cooling + proxies.retired}/${proxies.configured} proxies cooling or retired (${(degraded * 100).toFixed(0)}%, threshold ${(thresholds.proxyDegradedRatio * 100).toFixed(0)}%)`,
      });
    }
  }
  return findings;
}

/**
 * Compares mean queue depth in the last/first 20% of samples (after
 * discarding the very start, where a ramp is still filling the pipe) --
 * flags growth only when the queue is ALSO not draining, i.e. consumers, not
 * just admission, are backed up.
 */
function queueGrowthFindings(
  result: LoadGeneratorResult,
  thresholds: StressReportThresholds,
): CollapseFinding[] {
  const samples = result.queueSamples;
  if (samples.length < 10) return [];
  const bucket = Math.max(1, Math.floor(samples.length * 0.2));
  const first = samples.slice(0, bucket);
  const last = samples.slice(samples.length - bucket);
  const meanQueued = (rows: typeof samples): number =>
    rows.reduce((sum, row) => sum + row.queued, 0) / rows.length;
  const meanInFlight = (rows: typeof samples): number =>
    rows.reduce((sum, row) => sum + row.inFlight, 0) / rows.length;
  const firstQueued = meanQueued(first);
  const lastQueued = meanQueued(last);
  const lastConcurrency = last[last.length - 1]?.concurrency ?? 0;

  const growing = lastQueued > Math.max(1, firstQueued) * thresholds.queueGrowthRatio;
  const backedUp = lastConcurrency > 0 && meanInFlight(last) >= lastConcurrency * 0.9;
  if (!growing || !backedUp) return [];

  return [
    {
      kind: 'unbounded_queue_growth',
      severity: 'fail',
      message: `queue depth grew from a mean of ${firstQueued.toFixed(1)} to ${lastQueued.toFixed(1)} while in-flight stayed pinned near concurrency (${lastConcurrency}) -- consumers are behind, not just admission`,
    },
  ];
}

/** Soft/informational only: monotonic growth with no plateau. GC timing is too noisy for a hard threshold. */
function memoryGrowthFindings(result: LoadGeneratorResult): CollapseFinding[] {
  const ratio = memoryGrowthRatio(result);
  if (ratio === null || ratio < 1.5) return [];
  return [
    {
      kind: 'memory_growth',
      severity: 'warn',
      message: `RSS grew ${ratio.toFixed(2)}x from the first to the last 20% of samples with no observed plateau`,
    },
  ];
}

function memoryGrowthRatio(result: LoadGeneratorResult): number | null {
  const samples = result.memorySamples;
  if (samples.length < 10) return null;
  const bucket = Math.max(1, Math.floor(samples.length * 0.2));
  const mean = (rows: typeof samples): number =>
    rows.reduce((sum, row) => sum + row.rssBytes, 0) / rows.length;
  const first = mean(samples.slice(0, bucket));
  const last = mean(samples.slice(samples.length - bucket));
  if (first <= 0) return null;
  return last / first;
}

function fatalErrorFindings(phases: readonly PhaseResult[]): CollapseFinding[] {
  return phases
    .filter((phase) => phase.fatalError !== null)
    .map((phase) => ({
      kind: 'fatal_error' as const,
      severity: 'fail' as const,
      message: `phase "${phase.phase.name}" ended with a fatal error: ${phase.fatalError ?? 'unknown'}`,
    }));
}

function toReportPhase(phase: PhaseResult): StressReportPhase {
  return {
    name: phase.phase.name,
    targetRpm: phase.phase.targetRpm,
    durationMs: phase.finishedAt.getTime() - phase.startedAt.getTime(),
    requests: phase.summary.totals.requests,
    successes: phase.summary.totals.successes,
    failures: phase.summary.totals.failures,
    successRate: phase.summary.totals.success_rate,
  };
}

function emptyLatency(): LatencySummary {
  return { count: 0, p50_ms: null, p95_ms: null, max_ms: null, mean_ms: null };
}

function emptyProxies(): ProxySummary {
  return {
    mode: 'static',
    configured: 0,
    used: 0,
    available: 0,
    untested: 0,
    cooling: 0,
    saturated: 0,
    blocked: 0,
    retired: 0,
    total_in_flight: 0,
    capacity: null,
    pool_exhausted: 0,
    total_failures: 0,
    source: null,
    per_proxy: [],
  };
}
