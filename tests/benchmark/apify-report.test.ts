import { describe, expect, it } from 'vitest';

import { joinComparison } from '../../scripts/apify-comparison/compare.js';
import { buildEconomics } from '../../scripts/apify-comparison/economics.js';
import { renderReport } from '../../scripts/apify-comparison/report.js';
import { buildSummary, median } from '../../scripts/apify-comparison/summary.js';
import {
  EMPTY_METRICS,
  type BenchmarkMetrics,
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

function observation(
  videoId: string,
  metrics: Partial<BenchmarkMetrics>,
  ok = true,
): SourceObservation {
  return {
    videoId,
    ok,
    metrics: { ...EMPTY_METRICS, ...metrics },
    observedAt: '2026-08-19T10:00:00.000Z',
    latencyMs: 120,
    error: ok ? null : 'blocked: TikTok blocked the request',
    responseBytes: 2_000,
  };
}

function summaryFor(rows: readonly ComparisonRow[], mode: 'dry-run' | 'execute' = 'execute') {
  return buildSummary({
    generatedAt: '2026-08-19T10:00:00.000Z',
    mode,
    actorId: 'clockworks/tiktok-scraper',
    actorPathId: 'clockworks~tiktok-scraper',
    runId: mode === 'execute' ? 'RUN1' : null,
    terminalStatus: mode === 'execute' ? 'SUCCEEDED' : null,
    build: '0.1.42',
    datasetId: 'DS1',
    featureFlags: { shouldDownloadVideos: false, commentsPerPost: 0 },
    caps: { maxChargeUsd: 0.25, maxUrls: 5, localTimeoutMs: 15_000, apifyTimeoutMs: 120_000 },
    input: {
      path: 'urls.txt',
      candidates: rows.length,
      accepted: rows.length,
      rejected: 0,
      duplicatesCollapsed: 0,
      billableUrls: rows.length,
    },
    rows,
    apifyLatencyMs: 5_000,
    economics: buildEconomics({ run: null, rows, localResponseBytes: 4_000 }),
  });
}

describe('buildSummary', () => {
  it('counts agreement per metric and never reads absence as agreement', () => {
    const rows = joinComparison(
      [target('1'), target('2')],
      [
        observation('1', { views: 100, likes: 10, saves: null }),
        observation('2', { views: 200, likes: 20 }),
      ],
      [
        observation('1', { views: 100, likes: 11, saves: 5 }),
        observation('2', { views: 250, likes: 20 }),
      ],
    );
    const summary = summaryFor(rows);

    const views = summary.agreement.find((entry) => entry.metric === 'views');
    expect(views).toMatchObject({
      comparable: 2,
      identical: 1,
      differing: 1,
      maxAbsoluteDelta: 50,
    });

    const saves = summary.agreement.find((entry) => entry.metric === 'saves');
    expect(saves).toMatchObject({ comparable: 0, onlyApify: 1 });
  });

  it('counts granularity findings per view band', () => {
    const rows = joinComparison(
      [target('1'), target('2')],
      [observation('1', { views: 1_200_000 }), observation('2', { views: 45_600 })],
      [observation('1', { views: 1_234_567 }), observation('2', { views: 45_637 })],
    );
    const summary = summaryFor(rows);

    expect(summary.viewGranularity).toMatchObject({
      apifyMoreGranular: 2,
      apifyMoreGranularAbove10k: 2,
      apifyMoreGranularAbove1m: 1,
      samplesAbove10k: 2,
      samplesAbove1m: 1,
    });
  });

  it('states the sample limits as caveats', () => {
    const rows = joinComparison(
      [target('1')],
      [observation('1', { views: 500 })],
      [observation('1', { views: 500 })],
    );
    const caveats = summaryFor(rows).caveats.join(' ');

    expect(caveats).toMatch(/Neither source is ground truth/);
    expect(caveats).toMatch(/too few to generalise/);
    expect(caveats).toMatch(/No sample had 10,000\+/);
    expect(caveats).toMatch(/No sample had 1,000,000\+/);
  });
});

describe('median', () => {
  it('handles odd, even and empty inputs', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe('renderReport', () => {
  it('answers all seven questions in order', () => {
    const rows = joinComparison(
      [target('1')],
      [observation('1', { views: 1_200_000 })],
      [observation('1', { views: 1_234_567 })],
    );
    const report = renderReport(summaryFor(rows), rows);

    expect(report).toContain('## 1. Did Apify return the same rounded view values?');
    expect(report).toContain('## 2. Did it return more granular views');
    expect(report).toContain('## 3. Are likes, comments, shares, saves, handle and bio');
    expect(report).toContain('## 4. What failed for either source?');
    expect(report).toContain('## 5. What did the run cost?');
    expect(report).toContain('## 6. What bandwidth was observed');
    expect(report).toContain('## 7. Is there evidence to justify going further?');
  });

  it('never calls a more granular value exact', () => {
    const rows = joinComparison(
      [target('1')],
      [observation('1', { views: 1_200_000 })],
      [observation('1', { views: 1_234_567 })],
    );
    const report = renderReport(summaryFor(rows), rows);

    expect(report).toMatch(/more granular/i);
    expect(report).toMatch(/not.*the same as exact/i);
    expect(report).not.toMatch(/exact view count(?!\b.*no ground truth)/i);
  });

  it('prints unavailable rather than a fabricated cost', () => {
    const rows = joinComparison(
      [target('1')],
      [observation('1', { views: 100 })],
      [observation('1', { views: 100 })],
    );
    const report = renderReport(summaryFor(rows), rows);

    expect(report).toContain('Actual run cost: **_unavailable_**');
    expect(report).toContain('| 1,000 | _unavailable_ |');
  });

  it('reports both failures without letting one source cover for the other', () => {
    const rows = joinComparison(
      [target('1')],
      [observation('1', {}, false)],
      [observation('1', { views: 500 })],
    );
    const report = renderReport(summaryFor(rows), rows);

    expect(report).toMatch(/local: blocked/);
    expect(report).toContain('No video was read successfully by both sources');
  });

  it('says plainly that a dry run gathered nothing', () => {
    const report = renderReport(summaryFor([], 'dry-run'), []);
    expect(report).toContain('This was a **dry run**');
    expect(report).toContain('Not applicable: no data was gathered.');
  });

  it('keeps Apify and local bandwidth explicitly separate', () => {
    const rows = joinComparison(
      [target('1')],
      [observation('1', { views: 100 })],
      [observation('1', { views: 100 })],
    );
    const report = renderReport(summaryFor(rows), rows);

    expect(report).toMatch(/not\*\* the same quantity/);
    expect(report).toMatch(/billed by\s*\n?our proxy provider/);
  });
});
