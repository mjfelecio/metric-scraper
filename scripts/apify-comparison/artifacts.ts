import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ScrapeError } from '../../src/core/models/errors.js';
import { serializeSnapshotLine } from '../../src/core/output/serialize.js';
import { type MetricSnapshot } from '../../src/core/models/snapshot.js';
import { timestampSlug } from '../../src/infrastructure/output/run-paths.js';

import { redactDeep } from './redact.js';
import { type BenchmarkSummary } from './summary.js';
import { type BenchmarkTarget, type ComparisonRow } from './types.js';

export interface ComparisonPaths {
  readonly dir: string;
  readonly manifest: string;
  readonly localResults: string;
  readonly apifyDataset: string;
  readonly comparison: string;
  readonly summary: string;
  readonly report: string;
}

/**
 * One timestamped directory per experiment, under the already-ignored
 * `output/` tree so research artifacts can never be committed by accident.
 */
export function resolveComparisonPaths(outputDir: string, startedAt: Date): ComparisonPaths {
  const dir = path.resolve(outputDir, timestampSlug(startedAt));
  return {
    dir,
    manifest: path.join(dir, 'input-manifest.json'),
    localResults: path.join(dir, 'local-results.jsonl'),
    apifyDataset: path.join(dir, 'apify-dataset.json'),
    comparison: path.join(dir, 'comparison.jsonl'),
    summary: path.join(dir, 'summary.json'),
    report: path.join(dir, 'report.md'),
  };
}

export interface ArtifactPayload {
  readonly manifest: {
    readonly inputPath: string;
    readonly targets: readonly BenchmarkTarget[];
    readonly issues: unknown;
    readonly duplicatesCollapsed: number;
  };
  readonly localSnapshots: readonly MetricSnapshot[];
  /** The Actor's dataset exactly as received. Redacted, never otherwise edited. */
  readonly apifyDataset: unknown;
  readonly rows: readonly ComparisonRow[];
  readonly summary: BenchmarkSummary;
  readonly report: string;
  /** Literal secrets to scrub from every artifact before it touches disk. */
  readonly secrets: readonly string[];
}

/**
 * Writes the experiment to disk, redacting on the way out.
 *
 * Redaction happens here, at the single boundary where data becomes a file,
 * rather than being trusted to every producer upstream. Request headers are
 * never part of the payload at all — the `Authorization` header exists only
 * inside `ApifyClient.send` and is not returned to anyone.
 */
export async function writeArtifacts(
  paths: ComparisonPaths,
  payload: ArtifactPayload,
): Promise<void> {
  const secrets = payload.secrets;
  const clean = (value: unknown): unknown => redactDeep(value, { secrets });

  try {
    await mkdir(paths.dir, { recursive: true });

    await writeFile(paths.manifest, `${json(clean(payload.manifest))}\n`, 'utf8');
    await writeFile(paths.localResults, toSnapshotJsonl(payload.localSnapshots), 'utf8');
    await writeFile(paths.apifyDataset, `${json(clean(payload.apifyDataset))}\n`, 'utf8');
    await writeFile(paths.comparison, toJsonl(payload.rows, clean), 'utf8');
    await writeFile(paths.summary, `${json(clean(payload.summary))}\n`, 'utf8');
    await writeFile(paths.report, redactReport(payload.report, secrets), 'utf8');
  } catch (error) {
    throw new ScrapeError({
      code: 'output_error',
      message: `cannot write comparison artifacts to "${paths.dir}": ${
        error instanceof Error ? error.message : String(error)
      }`,
      cause: error,
    });
  }
}

function redactReport(report: string, secrets: readonly string[]): string {
  const redacted = redactDeep(report, { secrets });
  return typeof redacted === 'string' ? redacted : report;
}

/**
 * Local results reuse the production JSONL serializer, so the benchmark's own
 * copy of a scrape is byte-identical to what a real run would have written.
 */
function toSnapshotJsonl(snapshots: readonly MetricSnapshot[]): string {
  if (snapshots.length === 0) return '';
  return `${snapshots.map((snapshot) => serializeSnapshotLine(snapshot)).join('\n')}\n`;
}

/** One row per line — compact, never pretty-printed, or it would not be JSONL. */
function toJsonl(rows: readonly unknown[], clean: (value: unknown) => unknown): string {
  if (rows.length === 0) return '';
  return `${rows.map((row) => JSON.stringify(clean(row))).join('\n')}\n`;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
