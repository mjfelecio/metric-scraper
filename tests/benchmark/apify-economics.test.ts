import { describe, expect, it } from 'vitest';

import { type ApifyRun } from '../../scripts/apify-comparison/apify-client.js';
import { buildEconomics } from '../../scripts/apify-comparison/economics.js';
import { joinComparison } from '../../scripts/apify-comparison/compare.js';
import {
  EMPTY_METRICS,
  type BenchmarkTarget,
  type ComparisonRow,
  type SourceObservation,
} from '../../scripts/apify-comparison/types.js';

function target(videoId: string): BenchmarkTarget {
  return {
    videoId,
    url: `https://www.tiktok.com/@creator/video/${videoId}`,
    rawUrls: [],
    kind: 'video',
    handle: 'creator',
  };
}

function observation(videoId: string, ok: boolean): SourceObservation {
  return {
    videoId,
    ok,
    metrics: ok ? { ...EMPTY_METRICS, views: 100 } : EMPTY_METRICS,
    observedAt: '2026-08-19T10:00:00.000Z',
    latencyMs: 100,
    error: ok ? null : 'failed',
    responseBytes: 1_000,
  };
}

/** Two videos: both local successes, one Apify success and one Apify failure. */
function rows(): readonly ComparisonRow[] {
  return joinComparison(
    [target('1'), target('2')],
    [observation('1', true), observation('2', true)],
    [observation('1', true), observation('2', false)],
  );
}

function run(overrides: Partial<ApifyRun> = {}): ApifyRun {
  return {
    id: 'RUN1',
    actId: 'ACT1',
    status: 'SUCCEEDED',
    defaultDatasetId: 'DS1',
    buildNumber: '0.1.42',
    startedAt: '2026-08-19T10:00:00.000Z',
    finishedAt: '2026-08-19T10:00:12.000Z',
    usageTotalUsd: 0.02,
    chargedEventCounts: { 'video-result': 2 },
    pricingModel: 'PAY_PER_EVENT',
    netRxBytes: 400_000,
    netTxBytes: 20_000,
    runTimeSecs: 12,
    raw: {},
    ...overrides,
  };
}

describe('buildEconomics', () => {
  it('divides actual spend by results that were actually usable', () => {
    const report = buildEconomics({ run: run(), rows: rows(), localResponseBytes: 60_000 });

    expect(report.successfulApifyResults).toBe(1);
    expect(report.successfulLocalResults).toBe(2);
    // $0.02 over one usable Apify result, not over the two that were requested.
    expect(report.apifyCostPerSuccessUsd).toBeCloseTo(0.02, 10);
    expect(report.apifyBytesPerSuccess).toBe(400_000);
    expect(report.localBytesPerSuccess).toBe(30_000);
  });

  it('projects linearly and labels nothing it did not measure', () => {
    const report = buildEconomics({ run: run(), rows: rows(), localResponseBytes: 60_000 });

    expect(report.projections.map((entry) => entry.videos)).toEqual([1_000, 10_000, 100_000]);
    expect(report.projections[0]?.apifyCostUsd).toBeCloseTo(20, 6);
    expect(report.projections[2]?.apifyCostUsd).toBeCloseTo(2_000, 6);
    expect(report.projections[0]?.localBytes).toBe(30_000_000);
    expect(report.unavailable).toEqual([]);
  });

  it('reports missing cost data as null and names it, rather than inventing it', () => {
    const report = buildEconomics({
      run: run({
        usageTotalUsd: null,
        chargedEventCounts: null,
        pricingModel: null,
        netRxBytes: null,
        netTxBytes: null,
        buildNumber: null,
      }),
      rows: rows(),
      localResponseBytes: null,
    });

    expect(report.apifyCostPerSuccessUsd).toBeNull();
    expect(report.projections.every((entry) => entry.apifyCostUsd === null)).toBe(true);
    expect(report.unavailable).toEqual(
      expect.arrayContaining([
        'usageTotalUsd',
        'chargedEventCounts',
        'pricingModel',
        'build',
        'stats.netRxBytes',
        'stats.netTxBytes',
      ]),
    );
  });

  it('does not divide by zero when nothing succeeded', () => {
    const noSuccess = joinComparison(
      [target('1')],
      [observation('1', false)],
      [observation('1', false)],
    );
    const report = buildEconomics({ run: run(), rows: noSuccess, localResponseBytes: 5_000 });

    expect(report.apifyCostPerSuccessUsd).toBeNull();
    expect(report.localBytesPerSuccess).toBeNull();
  });

  it('falls back to the start/finish timestamps when runTimeSecs is absent', () => {
    const report = buildEconomics({
      run: run({ runTimeSecs: null }),
      rows: rows(),
      localResponseBytes: 1,
    });
    expect(report.economics.runDurationMs).toBe(12_000);
  });

  it('reports no run at all as entirely unavailable', () => {
    const report = buildEconomics({ run: null, rows: rows(), localResponseBytes: null });

    expect(report.economics.usageTotalUsd).toBeNull();
    expect(report.economics.runDurationMs).toBeNull();
    expect(report.unavailable).toContain('runDuration');
  });
});
