import { type NormalizedRow } from './actor-adapter.js';
import { diagnoseViewPrecision } from './view-precision.js';
import {
  COMPARABLE_METRICS,
  EMPTY_METRICS,
  type BenchmarkTarget,
  type ComparableMetric,
  type ComparisonRow,
  type MetricDelta,
  type SourceObservation,
} from './types.js';

export interface BuildApifyObservationsOptions {
  readonly targets: readonly BenchmarkTarget[];
  readonly rows: readonly NormalizedRow[];
  /** One timestamp for the whole dataset: Apify does not stamp rows individually. */
  readonly observedAt: string;
  readonly latencyMs: number;
  /** Apify's own `netRxBytes`, divided evenly, or `null` when unavailable. */
  readonly bytesPerRow: number | null;
}

/**
 * Turns the Actor's dataset into one observation per requested target.
 *
 * Joined by video id, never by position. Dataset order is not a contract — an
 * Actor that retries, parallelises or drops a URL will return rows in an order
 * that has nothing to do with the input, and a positional join would then
 * quietly attribute one video's metrics to another. That failure is invisible
 * in the output, which is exactly why it must be impossible by construction.
 */
export function buildApifyObservations(
  options: BuildApifyObservationsOptions,
): readonly SourceObservation[] {
  const byVideoId = new Map<string, NormalizedRow>();
  const unjoinable: NormalizedRow[] = [];

  for (const row of options.rows) {
    if (row.videoId === null) {
      unjoinable.push(row);
      continue;
    }
    // First row wins. A duplicate is worth knowing about but not worth
    // guessing between, and the raw dataset artifact retains both.
    if (!byVideoId.has(row.videoId)) byVideoId.set(row.videoId, row);
  }

  return options.targets.map((target): SourceObservation => {
    const row = byVideoId.get(target.videoId);

    if (row === undefined) {
      return {
        videoId: target.videoId,
        ok: false,
        metrics: EMPTY_METRICS,
        observedAt: options.observedAt,
        latencyMs: options.latencyMs,
        error:
          unjoinable.length > 0
            ? `missing_row: the Actor returned no row for this video (${unjoinable.length} row(s) could not be matched to any requested id)`
            : 'missing_row: the Actor returned no row for this video',
        responseBytes: options.bytesPerRow,
      };
    }

    if (row.kind === 'error') {
      return {
        videoId: target.videoId,
        ok: false,
        metrics: EMPTY_METRICS,
        observedAt: options.observedAt,
        latencyMs: options.latencyMs,
        error: `actor_error: ${row.message}`,
        responseBytes: options.bytesPerRow,
      };
    }

    return {
      videoId: target.videoId,
      ok: true,
      metrics: row.metrics,
      observedAt: options.observedAt,
      latencyMs: options.latencyMs,
      error: null,
      responseBytes: options.bytesPerRow,
    };
  });
}

/**
 * Pairs the two sources into one row per requested video.
 *
 * Both sides are looked up by id; a source that produced nothing for a target
 * still gets a row, marked failed. Nothing is dropped, and one source failing
 * never causes the other's numbers to stand in for it.
 */
export function joinComparison(
  targets: readonly BenchmarkTarget[],
  local: readonly SourceObservation[],
  apify: readonly SourceObservation[],
): readonly ComparisonRow[] {
  const localById = indexById(local);
  const apifyById = indexById(apify);

  return targets.map((target): ComparisonRow => {
    const localObservation = localById.get(target.videoId) ?? missing(target.videoId, 'local');
    const apifyObservation = apifyById.get(target.videoId) ?? missing(target.videoId, 'apify');

    const deltas = {} as Record<ComparableMetric, MetricDelta>;
    for (const metric of COMPARABLE_METRICS) {
      deltas[metric] = deltaFor(
        localObservation.ok ? localObservation.metrics[metric] : null,
        apifyObservation.ok ? apifyObservation.metrics[metric] : null,
      );
    }

    return {
      videoId: target.videoId,
      url: target.url,
      kind: target.kind,
      local: localObservation,
      apify: apifyObservation,
      deltas,
      viewPrecision: diagnoseViewPrecision(
        localObservation.ok ? localObservation.metrics.views : null,
        apifyObservation.ok ? apifyObservation.metrics.views : null,
      ),
      comparable: localObservation.ok && apifyObservation.ok,
    };
  });
}

export function deltaFor(local: number | null, apify: number | null): MetricDelta {
  if (local === null && apify === null) {
    return { local: null, apify: null, signed: null, absolute: null, same: null, onlyIn: null };
  }
  if (local === null) {
    return { local: null, apify, signed: null, absolute: null, same: null, onlyIn: 'apify' };
  }
  if (apify === null) {
    return { local, apify: null, signed: null, absolute: null, same: null, onlyIn: 'local' };
  }
  const signed = apify - local;
  return { local, apify, signed, absolute: Math.abs(signed), same: signed === 0, onlyIn: null };
}

function indexById(observations: readonly SourceObservation[]): Map<string, SourceObservation> {
  const index = new Map<string, SourceObservation>();
  for (const observation of observations) {
    if (!index.has(observation.videoId)) index.set(observation.videoId, observation);
  }
  return index;
}

function missing(videoId: string, source: 'local' | 'apify'): SourceObservation {
  return {
    videoId,
    ok: false,
    metrics: EMPTY_METRICS,
    observedAt: null,
    latencyMs: null,
    error: `missing_observation: the ${source} source produced no result for this video`,
    responseBytes: null,
  };
}
