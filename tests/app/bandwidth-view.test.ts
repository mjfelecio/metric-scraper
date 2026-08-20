import { describe, expect, it } from 'vitest';

import { bandwidthViewFromCycles, bandwidthViewFromSummary } from '../../src/app/bandwidth-view.js';
import { type RunSummary } from '../../src/core/models/run-summary.js';
import { type CycleSummary } from '../../src/core/models/session-summary.js';

/** Only `bandwidth` matters to the functions under test; the rest is unused. */
function summaryWith(bandwidth: RunSummary['bandwidth']): RunSummary {
  return { bandwidth } as unknown as RunSummary;
}

function cycleWith(summary: RunSummary | null): CycleSummary {
  return { summary } as unknown as CycleSummary;
}

describe('bandwidthViewFromSummary', () => {
  it('returns null when METRICS_BANDWIDTH was off (summary.bandwidth is null)', () => {
    expect(bandwidthViewFromSummary(summaryWith(null))).toBeNull();
  });

  it('returns null when there is no summary at all yet', () => {
    expect(bandwidthViewFromSummary(null)).toBeNull();
  });

  it("maps the persisted snake_case block onto the camelCase BandwidthView, R6: requests is the bandwidth block's own field", () => {
    const view = bandwidthViewFromSummary(
      summaryWith({
        requests: 142,
        request_bytes: 40_000,
        response_bytes: 1_393_600,
        total_bytes: 1_433_600,
        bytes_per_request: 10_096,
      }),
    );

    expect(view).toEqual({
      requests: 142,
      requestBytes: 40_000,
      responseBytes: 1_393_600,
      totalBytes: 1_433_600,
      bytesPerRequest: 10_096,
      perProxy: [],
    });
  });

  it('preserves a measured-but-empty run as bytesPerRequest: null, not 0', () => {
    const view = bandwidthViewFromSummary(
      summaryWith({
        requests: 0,
        request_bytes: 0,
        response_bytes: 0,
        total_bytes: 0,
        bytes_per_request: null,
      }),
    );

    expect(view?.bytesPerRequest).toBeNull();
    expect(view?.requests).toBe(0);
  });
});

describe('bandwidthViewFromCycles', () => {
  it('returns null when no cycle ever measured anything', () => {
    expect(bandwidthViewFromCycles([cycleWith(null), cycleWith(summaryWith(null))])).toBeNull();
  });

  it('returns null for an empty cycle list', () => {
    expect(bandwidthViewFromCycles([])).toBeNull();
  });

  it('sums across cycles, skipping a cycle that failed before producing a summary', () => {
    const view = bandwidthViewFromCycles([
      cycleWith(
        summaryWith({
          requests: 100,
          request_bytes: 10_000,
          response_bytes: 90_000,
          total_bytes: 100_000,
          bytes_per_request: 1_000,
        }),
      ),
      cycleWith(null), // this cycle threw before producing a summary
      cycleWith(
        summaryWith({
          requests: 50,
          request_bytes: 5_000,
          response_bytes: 45_000,
          total_bytes: 50_000,
          bytes_per_request: 1_000,
        }),
      ),
    ]);

    expect(view).toEqual({
      requests: 150,
      requestBytes: 15_000,
      responseBytes: 135_000,
      totalBytes: 150_000,
      bytesPerRequest: 1_000,
      perProxy: [],
    });
  });

  it('a cycle with measurement on but zero wire calls does not corrupt the sum', () => {
    const view = bandwidthViewFromCycles([
      cycleWith(
        summaryWith({
          requests: 0,
          request_bytes: 0,
          response_bytes: 0,
          total_bytes: 0,
          bytes_per_request: null,
        }),
      ),
      cycleWith(
        summaryWith({
          requests: 10,
          request_bytes: 1_000,
          response_bytes: 9_000,
          total_bytes: 10_000,
          bytes_per_request: 1_000,
        }),
      ),
    ]);

    expect(view).toEqual({
      requests: 10,
      requestBytes: 1_000,
      responseBytes: 9_000,
      totalBytes: 10_000,
      bytesPerRequest: 1_000,
      perProxy: [],
    });
  });
});
