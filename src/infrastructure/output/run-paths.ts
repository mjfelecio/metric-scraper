import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ScrapeError } from '../../core/models/errors.js';
import { type Platform } from '../../core/models/platform.js';
import { type RunSummary } from '../../core/models/run-summary.js';

export interface RunPaths {
  /** Append-only snapshot rows. */
  snapshots: string;
  /** Machine-readable run summary, written next to the snapshots. */
  summary: string;
  /** Identifier shared by both filenames. */
  slug: string;
}

/** `2026-08-17T10-04-31-123Z` — filesystem-safe and sortable. */
export function timestampSlug(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function resolveRunPaths(options: {
  outputDir: string;
  platform: Platform | null;
  startedAt: Date;
  /** Override the snapshots file, e.g. to append to one long-lived dataset. */
  snapshotsPath?: string | null | undefined;
}): RunPaths {
  const dir = path.resolve(options.outputDir);
  const slug = `${options.platform ?? 'mixed'}-${timestampSlug(options.startedAt)}`;
  const snapshots =
    options.snapshotsPath != null
      ? path.resolve(options.snapshotsPath)
      : path.join(dir, `${slug}.jsonl`);
  const summary = path.join(dir, `${slug}.summary.json`);
  return { snapshots, summary, slug };
}

export async function writeRunSummary(filePath: string, summary: RunSummary): Promise<void> {
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  } catch (error) {
    throw new ScrapeError({
      code: 'output_error',
      message: `cannot write run summary to "${filePath}": ${error instanceof Error ? error.message : String(error)}`,
      cause: error,
    });
  }
}
