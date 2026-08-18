import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ScrapeError } from '../../core/models/errors.js';
import { type Platform } from '../../core/models/platform.js';
import { type RunSummary } from '../../core/models/run-summary.js';
import { type SessionSummary } from '../../core/models/session-summary.js';

export interface RunPaths {
  /** Append-only snapshot rows. */
  snapshots: string;
  /** Machine-readable run summary, written next to the snapshots. */
  summary: string;
  /** Append-only record of proxy health transitions. */
  proxyEvents: string;
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
  const proxyEvents = path.join(dir, `${slug}.proxy-events.jsonl`);
  return { snapshots, summary, proxyEvents, slug };
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

export interface SessionPaths {
  /** One append-only file for every cycle in the session. */
  snapshots: string;
  /** Aggregate session summary. */
  summary: string;
  /** Append-only record of proxy health transitions across every cycle. */
  proxyEvents: string;
  /** Directory holding one summary per cycle. */
  cyclesDir: string;
  /** Path for cycle `n` (1-based). */
  cycleSummary: (cycle: number) => string;
  slug: string;
}

/**
 * Paths for a continuous session.
 *
 * All cycles append to one JSONL, which is exactly the append-only time series
 * the output contract describes — scraping the same video across cycles is the
 * point, not a duplicate to be reconciled later.
 */
export function resolveSessionPaths(options: {
  outputDir: string;
  platform: Platform | null;
  startedAt: Date;
  /** Override the snapshots file, e.g. to append to one long-lived dataset. */
  snapshotsPath?: string | null | undefined;
}): SessionPaths {
  const dir = path.resolve(options.outputDir);
  const slug = `${options.platform ?? 'mixed'}-${timestampSlug(options.startedAt)}`;
  const snapshots =
    options.snapshotsPath != null
      ? path.resolve(options.snapshotsPath)
      : path.join(dir, `${slug}.session.jsonl`);
  const cyclesDir = path.join(dir, 'cycles');

  return {
    snapshots,
    summary: path.join(dir, `${slug}.session.json`),
    proxyEvents: path.join(dir, `${slug}.proxy-events.jsonl`),
    cyclesDir,
    cycleSummary: (cycle: number): string =>
      path.join(cyclesDir, `${slug}.cycle-${String(cycle).padStart(3, '0')}.json`),
    slug,
  };
}

export async function writeSessionSummary(
  filePath: string,
  summary: SessionSummary,
): Promise<void> {
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  } catch (error) {
    throw new ScrapeError({
      code: 'output_error',
      message: `cannot write session summary to "${filePath}": ${error instanceof Error ? error.message : String(error)}`,
      cause: error,
    });
  }
}
