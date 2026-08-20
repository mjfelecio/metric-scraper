import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BandwidthAggregator } from '../../src/core/metrics/bandwidth.js';
import { MetricsCollector } from '../../src/core/metrics/metrics-collector.js';
import { type RunSummary } from '../../src/core/models/run-summary.js';
import { buildRunSummary } from '../../src/core/runner/build-summary.js';
import {
  appendBaseline,
  buildBaselineRecord,
  readBaselines,
  summarizeBaselines,
  type BandwidthBaselineRecord,
} from '../../src/infrastructure/output/bandwidth-baselines.js';
import { NullProxyPool } from '../../src/infrastructure/proxy/in-memory-proxy-pool.js';
import { NullSessionPool } from '../../src/infrastructure/session/in-memory-session-pool.js';

function record(runId: string, requests: number, totalBytes: number): BandwidthBaselineRecord {
  return {
    runId,
    finishedAt: `2026-08-20T00:00:0${runId}Z`,
    requests,
    totalBytes,
    avgBytesPerRequest: totalBytes / requests,
  };
}

/**
 * Builds a real `RunSummary` via the same collaborators production code uses
 * (`MetricsCollector`, `BandwidthAggregator`, `buildRunSummary`), so
 * `buildBaselineRecord` is tested against the actual shape it will see.
 *
 * `bandwidth: 'off'` never calls `recordBandwidth`, matching METRICS_BANDWIDTH
 * being disabled (`summary.bandwidth` stays `null`). `bandwidth: { samples, bytesEach }`
 * feeds that many samples into a `BandwidthAggregator` before finishing — passing
 * `samples: 0` reproduces "measurement on, but nothing was ever measured"
 * (every job failed before reaching the interceptor): `summary.bandwidth` is a
 * non-null object with `requests: 0`.
 */
function summaryWithBandwidth(options: {
  totalsRequests: number;
  bandwidth: 'off' | { samples: number; bytesEach: number };
}): RunSummary {
  const metrics = new MetricsCollector();
  metrics.start();
  for (let i = 0; i < options.totalsRequests; i += 1) {
    metrics.recordResult({ status: 'ok', latencyMs: 100, retries: 0, exhausted: false, errorCode: null });
  }
  if (options.bandwidth !== 'off') {
    const aggregator = new BandwidthAggregator();
    for (let i = 0; i < options.bandwidth.samples; i += 1) {
      aggregator.record({
        proxyId: null,
        host: 'example.com',
        requestBytes: options.bandwidth.bytesEach / 2,
        responseBytes: options.bandwidth.bytesEach / 2,
      });
    }
    metrics.recordBandwidth(aggregator.view());
  }
  metrics.finish();

  return buildRunSummary({
    runId: 'run-1',
    platform: null,
    startedAt: new Date('2026-08-20T00:00:00.000Z'),
    finishedAt: new Date('2026-08-20T00:01:00.000Z'),
    counts: {
      candidates: options.totalsRequests,
      accepted: options.totalsRequests,
      rejected: 0,
    },
    metrics: metrics.view(),
    proxyStats: new NullProxyPool().getStats(),
    sessionStats: new NullSessionPool().getStats(),
    concurrency: 1,
    targetRpm: 0,
    snapshotsPath: null,
    summaryPath: null,
    rowsWritten: options.totalsRequests,
  });
}

describe('summarizeBaselines', () => {
  /**
   * The two averages answer different questions and are both shown. A small
   * run must not drag the cost-predicting figure around.
   */
  it('weights the by-request average by traffic, not by run', () => {
    const summary = summarizeBaselines([
      record('1', 100, 5_000_000), // 50 KB/req
      record('2', 10_000, 100_000_000), // 10 KB/req
    ]);

    expect(summary.byRequest).toBeCloseTo(105_000_000 / 10_100, 2);
    expect(summary.byRun).toBeCloseTo((50_000 + 10_000) / 2, 2);
    expect(summary.runs).toBe(2);
  });

  it('uses the most recent record as the baseline', () => {
    const summary = summarizeBaselines([record('1', 10, 100), record('2', 10, 200)]);
    expect(summary.baseline?.runId).toBe('2');
  });

  it('excludes the current run from its own baseline', () => {
    // Comparing a run against itself would always report zero drift.
    const summary = summarizeBaselines([record('1', 10, 100), record('2', 10, 200)], '2');
    expect(summary.baseline?.runId).toBe('1');
  });

  it('reports nulls rather than zeros when there is no history', () => {
    const summary = summarizeBaselines([]);
    expect(summary.baseline).toBeNull();
    expect(summary.byRequest).toBeNull();
    expect(summary.byRun).toBeNull();
    expect(summary.runs).toBe(0);
  });

  it('ignores a record with no requests when averaging by run', () => {
    const summary = summarizeBaselines([
      record('1', 10, 1_000),
      { ...record('2', 1, 0), requests: 0 },
    ]);
    expect(summary.byRun).toBeCloseTo(100, 2);
  });

  /**
   * CONTROLLER RULING R2: the brief picked `baseline` from the unfiltered
   * record list while computing averages from `requests > 0` records only. A
   * zero-request run could then become the baseline, and since its own
   * avgBytesPerRequest is 0, a dashboard computing drift as
   * `current / baseline.avgBytesPerRequest` would divide by zero and get
   * Infinity or NaN. The baseline must be drawn from the same filtered pool
   * as the averages.
   */
  it('never selects a zero-request record as the baseline, even when most recent', () => {
    const summary = summarizeBaselines([
      record('1', 10, 1_000), // requests > 0
      { ...record('2', 1, 500), requests: 0 }, // most recent by position, but unmeasured
    ]);
    expect(summary.baseline?.runId).toBe('1');
  });

  it('falls back to null baseline when every record has zero requests', () => {
    const summary = summarizeBaselines([
      { ...record('1', 1, 100), requests: 0 },
      { ...record('2', 1, 200), requests: 0 },
    ]);
    expect(summary.baseline).toBeNull();
    expect(summary.runs).toBe(0);
  });
});

describe('buildBaselineRecord', () => {
  it('returns null when METRICS_BANDWIDTH was off (summary.bandwidth is null)', () => {
    const summary = summaryWithBandwidth({ totalsRequests: 5, bandwidth: 'off' });
    expect(summary.bandwidth).toBeNull();

    expect(buildBaselineRecord(summary)).toBeNull();
  });

  /**
   * CONTROLLER RULING R6 (Critical): `summary.bandwidth === null` only catches
   * "feature off". With METRICS_BANDWIDTH on but every job failing before it
   * reaches the counting interceptor, `bandwidth` is a non-null object with
   * `requests: 0` while `totals.requests` is still > 0 (URLs were attempted).
   * That must not be appended to the append-only history as a fabricated
   * zero-byte run.
   */
  it('returns null when bandwidth was measured but zero wire requests were recorded, even though totals.requests is positive', () => {
    const summary = summaryWithBandwidth({
      totalsRequests: 5,
      bandwidth: { samples: 0, bytesEach: 0 },
    });

    expect(summary.bandwidth).not.toBeNull();
    expect(summary.bandwidth?.requests).toBe(0);
    expect(summary.totals.requests).toBe(5);

    expect(buildBaselineRecord(summary)).toBeNull();
  });

  /**
   * CONTROLLER RULING R6 (Important): bytes accumulate once per dispatched
   * wire call (retries and multi-call jobs included), but `totals.requests`
   * counts URLs with retries excluded. `bandwidth.requests` — not
   * `totals.requests` — is the correct denominator.
   */
  it('uses bandwidth.requests, never totals.requests, as the record denominator', () => {
    const summary = summaryWithBandwidth({
      totalsRequests: 2,
      bandwidth: { samples: 5, bytesEach: 100 },
    });

    expect(summary.totals.requests).toBe(2);
    expect(summary.bandwidth?.requests).toBe(5);

    const built = buildBaselineRecord(summary);
    expect(built).not.toBeNull();
    expect(built?.requests).toBe(5);
    expect(built?.avgBytesPerRequest).toBeCloseTo(100);
  });

  it('builds a complete record from a normally measured run', () => {
    const summary = summaryWithBandwidth({
      totalsRequests: 3,
      bandwidth: { samples: 3, bytesEach: 1_000 },
    });

    expect(buildBaselineRecord(summary)).toEqual({
      runId: summary.run_id,
      finishedAt: summary.finished_at,
      requests: 3,
      totalBytes: 3_000,
      avgBytesPerRequest: 1_000,
    });
  });
});

describe('appendBaseline / readBaselines', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'metric-scraper-baselines-'));
    filePath = path.join(dir, 'bandwidth-baselines.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns an empty array and no skipped lines when no history file exists yet', async () => {
    const result = await readBaselines(filePath);
    expect(result.records).toEqual([]);
    expect(result.skippedLines).toBe(0);
  });

  it('round-trips one appended record', async () => {
    const entry = record('1', 10, 1_000);
    await appendBaseline(filePath, entry);

    const result = await readBaselines(filePath);
    expect(result.records).toEqual([entry]);
    expect(result.skippedLines).toBe(0);
  });

  it('appends rather than overwriting on repeated calls', async () => {
    await appendBaseline(filePath, record('1', 10, 1_000));
    await appendBaseline(filePath, record('2', 20, 2_000));

    const result = await readBaselines(filePath);
    expect(result.records.map((r) => r.runId)).toEqual(['1', '2']);
  });

  it('creates missing parent directories', async () => {
    const nested = path.join(dir, 'nested', 'deeper', 'bandwidth-baselines.jsonl');
    await appendBaseline(nested, record('1', 10, 1_000));

    const result = await readBaselines(nested);
    expect(result.records).toHaveLength(1);
  });

  it('skips a truncated final line left by a run killed mid-write', async () => {
    const good = record('1', 10, 1_000);
    const contents = `${JSON.stringify(good)}\n${JSON.stringify(record('2', 20, 2_000)).slice(0, 15)}`;
    await appendBaseline(filePath, good);
    // Overwrite with a deliberately truncated tail appended after the good line.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(filePath, contents, 'utf8');

    const result = await readBaselines(filePath);
    expect(result.records).toEqual([good]);
    expect(result.skippedLines).toBe(1);
  });

  it('skips a line that parses but is missing required fields', async () => {
    const good = record('1', 10, 1_000);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(filePath, `${JSON.stringify(good)}\n${JSON.stringify({ foo: 'bar' })}\n`, 'utf8');

    const result = await readBaselines(filePath);
    expect(result.records).toEqual([good]);
    expect(result.skippedLines).toBe(1);
  });

  /**
   * The other corruption tests each mix one good line with one bad, so an
   * empty `records` array always came with a non-zero `skippedLines` there.
   * A *wholly* corrupt file — every non-blank line unusable — is the case
   * that used to be indistinguishable from "no history file at all": both
   * returned `[]`. `skippedLines` is what tells them apart now.
   */
  it('reports every line as skipped when the whole file is corrupt, distinguishing it from no history at all', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(filePath, 'not json\n{"still": "not a baseline record"}\n{{{malformed\n', 'utf8');

    const result = await readBaselines(filePath);
    expect(result.records).toEqual([]);
    expect(result.skippedLines).toBe(3);

    const missing = await readBaselines(path.join(dir, 'does-not-exist.jsonl'));
    expect(missing.records).toEqual([]);
    expect(missing.skippedLines).toBe(0);
  });
});
