import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendBaseline,
  readBaselines,
  summarizeBaselines,
  type BandwidthBaselineRecord,
} from '../../src/infrastructure/output/bandwidth-baselines.js';

function record(runId: string, requests: number, totalBytes: number): BandwidthBaselineRecord {
  return {
    runId,
    finishedAt: `2026-08-20T00:00:0${runId}Z`,
    requests,
    totalBytes,
    avgBytesPerRequest: totalBytes / requests,
  };
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

  it('returns an empty array when no history file exists yet', async () => {
    const records = await readBaselines(filePath);
    expect(records).toEqual([]);
  });

  it('round-trips one appended record', async () => {
    const entry = record('1', 10, 1_000);
    await appendBaseline(filePath, entry);

    const records = await readBaselines(filePath);
    expect(records).toEqual([entry]);
  });

  it('appends rather than overwriting on repeated calls', async () => {
    await appendBaseline(filePath, record('1', 10, 1_000));
    await appendBaseline(filePath, record('2', 20, 2_000));

    const records = await readBaselines(filePath);
    expect(records.map((r) => r.runId)).toEqual(['1', '2']);
  });

  it('creates missing parent directories', async () => {
    const nested = path.join(dir, 'nested', 'deeper', 'bandwidth-baselines.jsonl');
    await appendBaseline(nested, record('1', 10, 1_000));

    const records = await readBaselines(nested);
    expect(records).toHaveLength(1);
  });

  it('skips a truncated final line left by a run killed mid-write', async () => {
    const good = record('1', 10, 1_000);
    const contents = `${JSON.stringify(good)}\n${JSON.stringify(record('2', 20, 2_000)).slice(0, 15)}`;
    await appendBaseline(filePath, good);
    // Overwrite with a deliberately truncated tail appended after the good line.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(filePath, contents, 'utf8');

    const records = await readBaselines(filePath);
    expect(records).toEqual([good]);
  });

  it('skips a line that parses but is missing required fields', async () => {
    const good = record('1', 10, 1_000);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(filePath, `${JSON.stringify(good)}\n${JSON.stringify({ foo: 'bar' })}\n`, 'utf8');

    const records = await readBaselines(filePath);
    expect(records).toEqual([good]);
  });
});
