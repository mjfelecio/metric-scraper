import { type ViewPrecisionDiagnosis } from './view-precision.js';

/**
 * Benchmark-only shapes.
 *
 * Deliberately separate from `MetricSnapshot`: the production contract is a
 * per-observation output row, and bending it to also carry a second source's
 * numbers, two latencies and a cost model would change a shipped contract for
 * an experiment. Nothing in `src/` imports this file.
 */

/** One unique post the benchmark will ask both sources about. */
export interface BenchmarkTarget {
  readonly videoId: string;
  /** Canonical URL, as produced by the production TikTok normalizer. */
  readonly url: string;
  /** Every raw input line that collapsed onto this target. */
  readonly rawUrls: readonly string[];
  readonly kind: 'video' | 'photo';
  readonly handle: string;
}

/** The metric set either source is expected to produce, absent fields as `null`. */
export interface BenchmarkMetrics {
  readonly views: number | null;
  readonly likes: number | null;
  readonly comments: number | null;
  readonly shares: number | null;
  readonly saves: number | null;
  readonly authorHandle: string | null;
  readonly authorBio: string | null;
  readonly authorFollowerCount: number | null;
  readonly postedAt: string | null;
}

export const EMPTY_METRICS: BenchmarkMetrics = {
  views: null,
  likes: null,
  comments: null,
  shares: null,
  saves: null,
  authorHandle: null,
  authorBio: null,
  authorFollowerCount: null,
  postedAt: null,
};

/** What one source managed for one target. Failure is data, not an exception. */
export interface SourceObservation {
  readonly videoId: string;
  readonly ok: boolean;
  readonly metrics: BenchmarkMetrics;
  /** ISO-8601 — each source keeps its own, so a slow run is visible as skew. */
  readonly observedAt: string | null;
  readonly latencyMs: number | null;
  /** `"<code>: <message>"`, already redacted. `null` on success. */
  readonly error: string | null;
  /** Response bytes attributable to this target, when measurable. */
  readonly responseBytes: number | null;
}

export const COMPARABLE_METRICS = ['views', 'likes', 'comments', 'shares', 'saves'] as const;
export type ComparableMetric = (typeof COMPARABLE_METRICS)[number];

export interface MetricDelta {
  readonly local: number | null;
  readonly apify: number | null;
  /** `apify - local`. `null` unless both sides reported a number. */
  readonly signed: number | null;
  readonly absolute: number | null;
  /** `null` rather than `false` when either side is missing — absence is not agreement. */
  readonly same: boolean | null;
  /** Only for a source that reported nothing where the other reported something. */
  readonly onlyIn: 'local' | 'apify' | null;
}

export interface ComparisonRow {
  readonly videoId: string;
  readonly url: string;
  readonly kind: 'video' | 'photo';
  readonly local: SourceObservation;
  readonly apify: SourceObservation;
  readonly deltas: Readonly<Record<ComparableMetric, MetricDelta>>;
  readonly viewPrecision: ViewPrecisionDiagnosis;
  /** True when both sources succeeded, i.e. the row supports any comparison at all. */
  readonly comparable: boolean;
}

/** Cost and bandwidth, populated only from what the API actually reported. */
export interface RunEconomics {
  readonly usageTotalUsd: number | null;
  readonly chargedEventCounts: Readonly<Record<string, number>> | null;
  readonly pricingModel: string | null;
  readonly build: string | null;
  readonly runDurationMs: number | null;
  readonly netRxBytes: number | null;
  readonly netTxBytes: number | null;
  /** Sum of local response bodies, measured by the benchmark's own decorator. */
  readonly localResponseBytes: number | null;
}
