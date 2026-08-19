import { type EconomicsReport } from './economics.js';
import { COMPARABLE_METRICS, type ComparableMetric, type ComparisonRow } from './types.js';

/** Per-metric agreement across the sample. */
export interface MetricAgreement {
  readonly metric: ComparableMetric;
  /** Rows where both sources reported a number. */
  readonly comparable: number;
  readonly identical: number;
  readonly differing: number;
  /** Rows where only one source had the metric at all. */
  readonly onlyLocal: number;
  readonly onlyApify: number;
  readonly maxAbsoluteDelta: number | null;
}

export interface ViewGranularityFindings {
  /** Rows where both sources reported views and the values matched exactly. */
  readonly identicalViews: number;
  /** Rows where Apify carried lower-order detail the local value did not. */
  readonly apifyMoreGranular: number;
  /** …of which the local value was 10,000+ / 1,000,000+ — the interesting bands. */
  readonly apifyMoreGranularAbove10k: number;
  readonly apifyMoreGranularAbove1m: number;
  /** Rows with a local 10k+/1M+ value at all, i.e. rows that could have shown it. */
  readonly samplesAbove10k: number;
  readonly samplesAbove1m: number;
  readonly disagreements: number;
}

export interface BenchmarkSummary {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly mode: 'dry-run' | 'execute';
  readonly actor: {
    readonly id: string;
    readonly pathId: string;
    readonly runId: string | null;
    readonly terminalStatus: string | null;
    readonly build: string | null;
    readonly datasetId: string | null;
    /** The exact input flags the run was started with, minus the URL list. */
    readonly featureFlags: Record<string, unknown>;
  };
  readonly caps: {
    readonly maxChargeUsd: number;
    readonly maxUrls: number;
    readonly localTimeoutMs: number;
    readonly apifyTimeoutMs: number;
  };
  readonly input: {
    readonly path: string;
    readonly candidates: number;
    readonly accepted: number;
    readonly rejected: number;
    readonly duplicatesCollapsed: number;
    readonly billableUrls: number;
  };
  readonly results: {
    readonly rows: number;
    readonly localSucceeded: number;
    readonly apifySucceeded: number;
    readonly bothSucceeded: number;
    readonly neitherSucceeded: number;
    readonly localMedianLatencyMs: number | null;
    readonly apifyLatencyMs: number | null;
  };
  readonly agreement: readonly MetricAgreement[];
  readonly viewGranularity: ViewGranularityFindings;
  readonly economics: EconomicsReport;
  /** Honest limits of this sample, restated in machine-readable form. */
  readonly caveats: readonly string[];
}

export interface BuildSummaryOptions {
  readonly generatedAt: string;
  readonly mode: 'dry-run' | 'execute';
  readonly actorId: string;
  readonly actorPathId: string;
  readonly runId: string | null;
  readonly terminalStatus: string | null;
  readonly build: string | null;
  readonly datasetId: string | null;
  readonly featureFlags: Record<string, unknown>;
  readonly caps: BenchmarkSummary['caps'];
  readonly input: BenchmarkSummary['input'];
  readonly rows: readonly ComparisonRow[];
  readonly apifyLatencyMs: number | null;
  readonly economics: EconomicsReport;
}

export function buildSummary(options: BuildSummaryOptions): BenchmarkSummary {
  const { rows } = options;

  return {
    schemaVersion: 1,
    generatedAt: options.generatedAt,
    mode: options.mode,
    actor: {
      id: options.actorId,
      pathId: options.actorPathId,
      runId: options.runId,
      terminalStatus: options.terminalStatus,
      build: options.build,
      datasetId: options.datasetId,
      featureFlags: options.featureFlags,
    },
    caps: options.caps,
    input: options.input,
    results: {
      rows: rows.length,
      localSucceeded: rows.filter((row) => row.local.ok).length,
      apifySucceeded: rows.filter((row) => row.apify.ok).length,
      bothSucceeded: rows.filter((row) => row.comparable).length,
      neitherSucceeded: rows.filter((row) => !row.local.ok && !row.apify.ok).length,
      localMedianLatencyMs: median(
        rows.map((row) => row.local.latencyMs).filter((value): value is number => value !== null),
      ),
      apifyLatencyMs: options.apifyLatencyMs,
    },
    agreement: COMPARABLE_METRICS.map((metric) => summarizeMetric(metric, rows)),
    viewGranularity: summarizeViewGranularity(rows),
    economics: options.economics,
    caveats: buildCaveats(rows),
  };
}

function summarizeMetric(
  metric: ComparableMetric,
  rows: readonly ComparisonRow[],
): MetricAgreement {
  let comparable = 0;
  let identical = 0;
  let differing = 0;
  let onlyLocal = 0;
  let onlyApify = 0;
  let maxAbsoluteDelta: number | null = null;

  for (const row of rows) {
    const delta = row.deltas[metric];
    if (delta.onlyIn === 'local') onlyLocal += 1;
    if (delta.onlyIn === 'apify') onlyApify += 1;
    if (delta.same === null) continue;

    comparable += 1;
    if (delta.same) identical += 1;
    else differing += 1;
    if (delta.absolute !== null) {
      maxAbsoluteDelta =
        maxAbsoluteDelta === null ? delta.absolute : Math.max(maxAbsoluteDelta, delta.absolute);
    }
  }

  return { metric, comparable, identical, differing, onlyLocal, onlyApify, maxAbsoluteDelta };
}

function summarizeViewGranularity(rows: readonly ComparisonRow[]): ViewGranularityFindings {
  const findings = {
    identicalViews: 0,
    apifyMoreGranular: 0,
    apifyMoreGranularAbove10k: 0,
    apifyMoreGranularAbove1m: 0,
    samplesAbove10k: 0,
    samplesAbove1m: 0,
    disagreements: 0,
  };

  for (const row of rows) {
    const views = row.deltas.views;
    if (views.same === true) findings.identicalViews += 1;
    if (views.same === false) findings.disagreements += 1;

    const localViews = views.local;
    if (localViews !== null && localViews >= 10_000) findings.samplesAbove10k += 1;
    if (localViews !== null && localViews >= 1_000_000) findings.samplesAbove1m += 1;

    if (row.viewPrecision.apifyMoreGranular === true) {
      findings.apifyMoreGranular += 1;
      if (localViews !== null && localViews >= 10_000) findings.apifyMoreGranularAbove10k += 1;
      if (localViews !== null && localViews >= 1_000_000) findings.apifyMoreGranularAbove1m += 1;
    }
  }

  return findings;
}

/**
 * The limits of the sample, stated up front.
 *
 * These are not decorative. The question this benchmark exists to answer is
 * whether Apify's numbers are *better*, and neither source here is ground
 * truth — so a small sample or a band with no coverage has to be called out or
 * the report will read as more conclusive than the data supports.
 */
export function buildCaveats(rows: readonly ComparisonRow[]): readonly string[] {
  const caveats: string[] = [
    'Neither source is ground truth. This compares two public readings of the same ' +
      'post; a value with more trailing digits is more granular, not verified exact.',
  ];

  const comparable = rows.filter((row) => row.comparable).length;
  if (comparable === 0) {
    caveats.push('No video was successfully read by both sources, so nothing was compared.');
  } else if (comparable < 5) {
    caveats.push(
      `Only ${comparable} video(s) were read by both sources — far too few to generalise from.`,
    );
  }

  const above10k = rows.filter(
    (row) => row.deltas.views.local !== null && row.deltas.views.local >= 10_000,
  ).length;
  if (above10k === 0) {
    caveats.push(
      'No sample had 10,000+ local views, so this run says nothing about rounding above that threshold.',
    );
  }

  const above1m = rows.filter(
    (row) => row.deltas.views.local !== null && row.deltas.views.local >= 1_000_000,
  ).length;
  if (above1m === 0) {
    caveats.push(
      'No sample had 1,000,000+ local views, the band where public rounding is coarsest.',
    );
  }

  return caveats;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const low = sorted[middle - 1];
  const high = sorted[middle];
  return low === undefined || high === undefined ? null : (low + high) / 2;
}
