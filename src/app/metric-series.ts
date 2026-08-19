import { type CycleSummary } from '../core/models/session-summary.js';
import { type MetricSnapshot } from '../core/models/snapshot.js';

import { type MetricPointDto } from './types.js';

/**
 * Accumulates the live metric time series for a single-URL continuous session.
 *
 * Deliberately a pure function over a caller-owned array rather than a class:
 * the session already owns the only copy of this state, and keeping the rule
 * ("one point per completed cycle") in one testable place is the whole point.
 */

/**
 * Ceiling on retained points, mirroring the timeline's own cap.
 *
 * A point per cycle is far cheaper than a point per second, but a back-to-back
 * session left running overnight would still grow without one.
 */
export const MAX_METRIC_POINTS = 1_000;

/**
 * Appends exactly one point for a cycle that has completed.
 *
 * `snapshot` is `null` when the cycle produced no result at all — it threw
 * before scraping. That still yields a point, with null counts: a cycle that
 * came back empty is information, and dropping it would silently break the
 * one-point-per-cycle correspondence the chart relies on.
 */
export function appendMetricPoint(
  series: MetricPointDto[],
  cycle: CycleSummary,
  snapshot: MetricSnapshot | null,
): void {
  series.push(
    snapshot === null
      ? {
          cycle: cycle.cycle,
          at: cycle.finished_at,
          status: 'error',
          views: null,
          likes: null,
          comments: null,
          shares: null,
        }
      : {
          cycle: cycle.cycle,
          at: snapshot.scraped_at,
          status: snapshot.status,
          // Passed through untouched. Whatever the platform returned — including
          // a quantized public view count — is what the chart must show.
          views: snapshot.views,
          likes: snapshot.likes,
          comments: snapshot.comments,
          shares: snapshot.shares,
        },
  );

  if (series.length > MAX_METRIC_POINTS) {
    series.splice(0, series.length - MAX_METRIC_POINTS);
  }
}
