import { type BandwidthView } from '../core/metrics/bandwidth.js';
import { type RunSummary } from '../core/models/run-summary.js';
import { type CycleSummary } from '../core/models/session-summary.js';

/**
 * Converts the persisted (snake_case) `RunSummary.bandwidth` block into the
 * camelCase `BandwidthView` the dashboard renders from.
 *
 * `perProxy` is deliberately left empty. The persisted summary's per-proxy
 * bandwidth (`summary.proxies.per_proxy[].request_bytes` /`.response_bytes`)
 * is nullable *per proxy* even when this top-level block is measured — a
 * proxy that was configured but never leased has no bucket in the aggregator
 * and reads back as `null`, not `0`. The dashboard panel does not render a
 * per-proxy breakdown (the existing proxy-pool panel already covers that
 * table), so reconstructing `perProxy` here would only risk quietly turning
 * one of those per-proxy `null`s into a fabricated `0` for no reader.
 */
export function bandwidthViewFromSummary(summary: RunSummary | null): BandwidthView | null {
  const bandwidth = summary?.bandwidth;
  if (bandwidth == null) return null;

  return {
    requests: bandwidth.requests,
    requestBytes: bandwidth.request_bytes,
    responseBytes: bandwidth.response_bytes,
    totalBytes: bandwidth.total_bytes,
    bytesPerRequest: bandwidth.bytes_per_request,
    perProxy: [],
  };
}

/**
 * Cumulative bandwidth across every cycle of a continuous session so far.
 *
 * A session has no single cumulative bandwidth object of its own — each
 * `CycleSummary.summary` is one cycle's own `RunSummary` — so this sums across
 * whatever cycles have finished. A cycle whose `summary` is `null` (it threw
 * before producing one) contributes nothing rather than breaking the sum.
 *
 * Returns `null`, not a zeroed object, when no finished cycle ever measured
 * anything: either `METRICS_BANDWIDTH` was off for the whole session, or
 * nothing has finished yet. That keeps an unmeasured session from
 * masquerading as "measured, used nothing" (see `BandwidthView`).
 */
export function bandwidthViewFromCycles(cycles: readonly CycleSummary[]): BandwidthView | null {
  let requests = 0;
  let requestBytes = 0;
  let responseBytes = 0;
  let totalBytes = 0;
  let measured = false;

  for (const cycle of cycles) {
    const bandwidth = cycle.summary?.bandwidth;
    if (bandwidth == null) continue;
    measured = true;
    requests += bandwidth.requests;
    requestBytes += bandwidth.request_bytes;
    responseBytes += bandwidth.response_bytes;
    totalBytes += bandwidth.total_bytes;
  }

  if (!measured) return null;

  return {
    requests,
    requestBytes,
    responseBytes,
    totalBytes,
    bytesPerRequest: requests === 0 ? null : totalBytes / requests,
    perProxy: [],
  };
}
