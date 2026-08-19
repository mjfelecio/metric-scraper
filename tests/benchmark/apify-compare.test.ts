import { describe, expect, it } from 'vitest';

import { type NormalizedRow } from '../../scripts/apify-comparison/actor-adapter.js';
import {
  buildApifyObservations,
  deltaFor,
  joinComparison,
} from '../../scripts/apify-comparison/compare.js';
import {
  EMPTY_METRICS,
  type BenchmarkTarget,
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

function okRow(videoId: string, views: number): NormalizedRow {
  return {
    kind: 'ok',
    videoId,
    url: `https://www.tiktok.com/@creator/video/${videoId}`,
    metrics: { ...EMPTY_METRICS, views },
  };
}

function observation(
  videoId: string,
  overrides: Partial<SourceObservation> = {},
): SourceObservation {
  return {
    videoId,
    ok: true,
    metrics: EMPTY_METRICS,
    observedAt: '2026-08-19T10:00:00.000Z',
    latencyMs: 100,
    error: null,
    responseBytes: 1_000,
    ...overrides,
  };
}

const OBSERVATION_CONTEXT = {
  observedAt: '2026-08-19T10:00:00.000Z',
  latencyMs: 5_000,
  bytesPerRow: null,
};

describe('buildApifyObservations', () => {
  it('joins by video id even when the Actor returns rows in a different order', () => {
    const observations = buildApifyObservations({
      targets: [target('1'), target('2'), target('3')],
      rows: [okRow('3', 300), okRow('1', 100), okRow('2', 200)],
      ...OBSERVATION_CONTEXT,
    });

    expect(observations.map((entry) => entry.metrics.views)).toEqual([100, 200, 300]);
  });

  it('marks a requested video the Actor never returned as a failure', () => {
    const observations = buildApifyObservations({
      targets: [target('1'), target('2')],
      rows: [okRow('1', 100)],
      ...OBSERVATION_CONTEXT,
    });

    expect(observations[1]).toMatchObject({ videoId: '2', ok: false });
    expect(observations[1]?.error).toMatch(/missing_row/);
    expect(observations[1]?.metrics.views).toBeNull();
  });

  it('surfaces an Actor error row as that video failing', () => {
    const observations = buildApifyObservations({
      targets: [target('1')],
      rows: [{ kind: 'error', videoId: '1', url: null, message: 'video is private' }],
      ...OBSERVATION_CONTEXT,
    });

    expect(observations[0]).toMatchObject({ ok: false });
    expect(observations[0]?.error).toMatch(/actor_error: video is private/);
  });

  it('mentions rows that could not be matched to any requested id', () => {
    const observations = buildApifyObservations({
      targets: [target('1')],
      rows: [{ kind: 'ok', videoId: null, url: null, metrics: EMPTY_METRICS }],
      ...OBSERVATION_CONTEXT,
    });

    expect(observations[0]?.error).toMatch(/1 row\(s\) could not be matched/);
  });

  it('keeps the first row when the Actor returns a duplicate id', () => {
    const observations = buildApifyObservations({
      targets: [target('1')],
      rows: [okRow('1', 100), okRow('1', 999)],
      ...OBSERVATION_CONTEXT,
    });

    expect(observations[0]?.metrics.views).toBe(100);
  });
});

describe('deltaFor', () => {
  it('computes signed and absolute deltas in Apify-minus-local terms', () => {
    expect(deltaFor(100, 130)).toEqual({
      local: 100,
      apify: 130,
      signed: 30,
      absolute: 30,
      same: false,
      onlyIn: null,
    });
    expect(deltaFor(130, 100).signed).toBe(-30);
    expect(deltaFor(130, 100).absolute).toBe(30);
  });

  it('reports identical values as the same', () => {
    expect(deltaFor(100, 100).same).toBe(true);
  });

  it('never reads a missing value as agreement', () => {
    expect(deltaFor(100, null)).toMatchObject({ same: null, onlyIn: 'local', signed: null });
    expect(deltaFor(null, 100)).toMatchObject({ same: null, onlyIn: 'apify', signed: null });
    expect(deltaFor(null, null)).toMatchObject({ same: null, onlyIn: null });
  });
});

describe('joinComparison', () => {
  it('produces one row per requested video, joined by id not by order', () => {
    const rows = joinComparison(
      [target('1'), target('2')],
      [
        observation('2', { metrics: { ...EMPTY_METRICS, views: 222 } }),
        observation('1', { metrics: { ...EMPTY_METRICS, views: 111 } }),
      ],
      [
        observation('1', { metrics: { ...EMPTY_METRICS, views: 111 }, latencyMs: 5_000 }),
        observation('2', { metrics: { ...EMPTY_METRICS, views: 999 }, latencyMs: 5_000 }),
      ],
    );

    expect(rows.map((row) => row.videoId)).toEqual(['1', '2']);
    expect(rows[0]?.deltas.views).toMatchObject({ local: 111, apify: 111, same: true });
    expect(rows[1]?.deltas.views).toMatchObject({ local: 222, apify: 999, signed: 777 });
  });

  it("keeps each source's latency separate", () => {
    const rows = joinComparison(
      [target('1')],
      [observation('1', { latencyMs: 120 })],
      [observation('1', { latencyMs: 9_000 })],
    );

    expect(rows[0]?.local.latencyMs).toBe(120);
    expect(rows[0]?.apify.latencyMs).toBe(9_000);
  });

  it('never substitutes one source for the other when one fails', () => {
    const rows = joinComparison(
      [target('1')],
      [observation('1', { ok: false, error: 'blocked', metrics: EMPTY_METRICS })],
      [observation('1', { metrics: { ...EMPTY_METRICS, views: 500 } })],
    );

    expect(rows[0]?.comparable).toBe(false);
    expect(rows[0]?.local.metrics.views).toBeNull();
    expect(rows[0]?.deltas.views).toMatchObject({ onlyIn: 'apify', same: null });
    expect(rows[0]?.viewPrecision.apifyMoreGranular).toBeNull();
  });

  it('records a row even when a source produced nothing at all for a target', () => {
    const rows = joinComparison([target('1')], [], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.local.error).toMatch(/missing_observation/);
    expect(rows[0]?.apify.error).toMatch(/missing_observation/);
  });

  it('diagnoses view granularity on comparable rows', () => {
    const rows = joinComparison(
      [target('1')],
      [observation('1', { metrics: { ...EMPTY_METRICS, views: 1_200_000 } })],
      [observation('1', { metrics: { ...EMPTY_METRICS, views: 1_234_567 } })],
    );

    expect(rows[0]?.comparable).toBe(true);
    expect(rows[0]?.viewPrecision.apifyMoreGranular).toBe(true);
  });
});
