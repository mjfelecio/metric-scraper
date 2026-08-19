import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  resolveComparisonPaths,
  writeArtifacts,
} from '../../scripts/apify-comparison/artifacts.js';
import { joinComparison } from '../../scripts/apify-comparison/compare.js';
import { buildEconomics } from '../../scripts/apify-comparison/economics.js';
import { renderReport } from '../../scripts/apify-comparison/report.js';
import { buildSummary } from '../../scripts/apify-comparison/summary.js';
import {
  EMPTY_METRICS,
  type BenchmarkTarget,
  type SourceObservation,
} from '../../scripts/apify-comparison/types.js';
import { createSuccessSnapshot, EMPTY_VIDEO_DATA } from '../../src/core/models/snapshot.js';
import { parseSnapshotLine } from '../../src/core/output/serialize.js';

const TOKEN = 'apify_api_0123456789abcdef';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'metric-scraper-benchmark-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const target: BenchmarkTarget = {
  videoId: '7643585712641559841',
  url: 'https://www.tiktok.com/@creator/video/7643585712641559841',
  rawUrls: ['https://www.tiktok.com/@creator/video/7643585712641559841'],
  kind: 'video',
  handle: 'creator',
};

function observation(views: number): SourceObservation {
  return {
    videoId: target.videoId,
    ok: true,
    metrics: { ...EMPTY_METRICS, views },
    observedAt: '2026-08-19T10:00:00.000Z',
    latencyMs: 120,
    error: null,
    responseBytes: 2_000,
  };
}

function payload() {
  const rows = joinComparison([target], [observation(1_200_000)], [observation(1_234_567)]);
  const economics = buildEconomics({ run: null, rows, localResponseBytes: 2_000 });
  const summary = buildSummary({
    generatedAt: '2026-08-19T10:00:00.000Z',
    mode: 'execute',
    actorId: 'clockworks/tiktok-scraper',
    actorPathId: 'clockworks~tiktok-scraper',
    runId: 'RUN1',
    terminalStatus: 'SUCCEEDED',
    build: '0.1.42',
    datasetId: 'DS1',
    featureFlags: { shouldDownloadVideos: false },
    caps: { maxChargeUsd: 0.25, maxUrls: 5, localTimeoutMs: 15_000, apifyTimeoutMs: 120_000 },
    input: {
      path: 'urls.txt',
      candidates: 1,
      accepted: 1,
      rejected: 0,
      duplicatesCollapsed: 0,
      billableUrls: 1,
    },
    rows,
    apifyLatencyMs: 5_000,
    economics,
  });

  return {
    rows,
    summary,
    manifest: { inputPath: 'urls.txt', targets: [target], issues: [], duplicatesCollapsed: 0 },
    localSnapshots: [
      createSuccessSnapshot(
        {
          platform: 'tiktok' as const,
          url: target.url,
          scrapedAt: new Date('2026-08-19T10:00:00.000Z'),
          latencyMs: 120,
        },
        { ...EMPTY_VIDEO_DATA, video_id: target.videoId, views: 1_200_000 },
      ),
    ],
    // A dataset that echoes the token back, which is exactly what redaction is for.
    apifyDataset: [{ id: target.videoId, playCount: 1_234_567, debugUrl: `https://x?t=${TOKEN}` }],
    report: renderReport(summary, rows),
    secrets: [TOKEN],
  };
}

describe('writeArtifacts', () => {
  it('writes the full artifact set into a timestamped directory', async () => {
    const paths = resolveComparisonPaths(dir, new Date('2026-08-19T10:04:31.123Z'));
    await writeArtifacts(paths, payload());

    expect(path.basename(paths.dir)).toBe('2026-08-19T10-04-31-123Z');
    for (const file of [
      paths.manifest,
      paths.localResults,
      paths.apifyDataset,
      paths.comparison,
      paths.summary,
      paths.report,
    ]) {
      await expect(readFile(file, 'utf8')).resolves.toBeTruthy();
    }
  });

  it('redacts secrets recursively before anything touches the disk', async () => {
    const paths = resolveComparisonPaths(dir, new Date('2026-08-19T10:04:31.123Z'));
    await writeArtifacts(paths, payload());

    for (const file of [paths.apifyDataset, paths.summary, paths.comparison, paths.report]) {
      const contents = await readFile(file, 'utf8');
      expect(contents).not.toContain(TOKEN);
    }
    expect(await readFile(paths.apifyDataset, 'utf8')).toContain('[redacted]');
  });

  it('writes JSONL as one row per line, not pretty-printed', async () => {
    const paths = resolveComparisonPaths(dir, new Date('2026-08-19T10:04:31.123Z'));
    await writeArtifacts(paths, payload());

    const comparison = await readFile(paths.comparison, 'utf8');
    const lines = comparison.split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    expect(() => {
      JSON.parse(lines[0] ?? '');
    }).not.toThrow();
  });

  it('writes local results in the production snapshot format', async () => {
    const paths = resolveComparisonPaths(dir, new Date('2026-08-19T10:04:31.123Z'));
    await writeArtifacts(paths, payload());

    const contents = await readFile(paths.localResults, 'utf8');
    const lines = contents.split('\n').filter((line) => line.length > 0);
    // Round-trips through the production parser, so the artifact is a real
    // JSONL dataset rather than a benchmark-shaped lookalike.
    expect(parseSnapshotLine(lines[0] ?? '')).toMatchObject({
      platform: 'tiktok',
      video_id: target.videoId,
      views: 1_200_000,
      status: 'ok',
    });
  });

  it('preserves the raw Apify dataset apart from redaction', async () => {
    const paths = resolveComparisonPaths(dir, new Date('2026-08-19T10:04:31.123Z'));
    await writeArtifacts(paths, payload());

    const dataset = JSON.parse(await readFile(paths.apifyDataset, 'utf8')) as unknown[];
    expect(dataset[0]).toMatchObject({ id: target.videoId, playCount: 1_234_567 });
  });

  it('reports an unwritable destination as an output error', async () => {
    const paths = resolveComparisonPaths(path.join(dir, 'run'), new Date());
    // A file where the directory needs to be.
    await writeArtifacts(paths, payload());
    const blocked = resolveComparisonPaths(paths.summary, new Date());
    await expect(writeArtifacts(blocked, payload())).rejects.toThrow(
      /cannot write comparison artifacts/,
    );
  });
});
