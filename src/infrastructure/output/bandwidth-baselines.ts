import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { type RunSummary } from '../../core/models/run-summary.js';

/** One completed run's bandwidth, appended when the run finishes. */
export interface BandwidthBaselineRecord {
  readonly runId: string;
  readonly finishedAt: string;
  readonly requests: number;
  readonly totalBytes: number;
  readonly avgBytesPerRequest: number;
}

/**
 * Reading a baseline history from disk: the parsed records, plus how many
 * non-blank lines could not be used.
 *
 * A truncated final line (a run killed mid-write) is expected and not counted
 * as a problem by {@link readBaselines} itself — but a file where *every*
 * line fails to parse looks, from an empty `records` array alone, exactly
 * like a file that has never been written to. `skippedLines` is what lets a
 * caller tell "no history yet" apart from "history file is corrupt" instead
 * of silently treating both as zero history.
 */
export interface ReadBaselinesResult {
  readonly records: readonly BandwidthBaselineRecord[];
  readonly skippedLines: number;
}

export interface BaselineSummary {
  /** The most recent run other than the current one. `null` with no history. */
  readonly baseline: BandwidthBaselineRecord | null;
  readonly runs: number;
  /**
   * Total bytes / total requests across every run.
   *
   * This is the figure that predicts a bill, because it weights each run by
   * the traffic it actually sent.
   */
  readonly byRequest: number | null;
  /**
   * Mean of each run's own average.
   *
   * Weights every run equally, which is better for spotting one odd run and
   * worse for predicting cost. Shown alongside `byRequest`; a wide gap between
   * them means runs differ a lot in size.
   */
  readonly byRun: number | null;
}

/** Appends one record to the history file, creating its directory if needed. */
export async function appendBaseline(path_: string, record: BandwidthBaselineRecord): Promise<void> {
  await mkdir(path.dirname(path_), { recursive: true });
  await appendFile(path_, `${JSON.stringify(record)}\n`, 'utf8');
}

/**
 * Reads the append-only log, skipping any line that is not usable.
 *
 * A missing file (`records: [], skippedLines: 0`) and a file that is present
 * but wholly corrupt (`records: [], skippedLines: N`) both yield no records,
 * but are distinguishable via `skippedLines` — see {@link ReadBaselinesResult}.
 */
export async function readBaselines(path_: string): Promise<ReadBaselinesResult> {
  let raw: string;
  try {
    raw = await readFile(path_, 'utf8');
  } catch {
    // No history yet is the normal first-run state, not an error.
    return { records: [], skippedLines: 0 };
  }

  const records: BandwidthBaselineRecord[] = [];
  let skippedLines = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) {
        records.push(parsed);
      } else {
        // Parsed as JSON but missing/mistyped required fields.
        skippedLines += 1;
      }
    } catch {
      // A truncated final line is expected if a run was killed mid-write;
      // any other unparseable line lands here too.
      skippedLines += 1;
    }
  }
  return { records, skippedLines };
}

/**
 * Builds the record for one finished run, or `null` when it must not be
 * appended to the history.
 *
 * Two cases must not enter the history:
 * - `bandwidth === null`: METRICS_BANDWIDTH was off, so nothing was measured.
 * - `bandwidth.requests === 0`: measurement was on but no wire round trip was
 *   ever recorded (e.g. every job failed before reaching the interceptor).
 *   `bandwidth` is a non-null object in this case with `total_bytes: 0`, so
 *   the `bandwidth === null` check alone does not catch it — and appending it
 *   would put a fabricated zero into a permanent, append-only history.
 *
 * `requests` is drawn from `bandwidth.requests` (the true count of measured
 * wire round trips, including retries and multi-call jobs), never from
 * `summary.totals.requests` (URLs processed, retries excluded) — bytes
 * accumulate once per wire call, so the wire-call count is the only honest
 * denominator for `avgBytesPerRequest`.
 */
export function buildBaselineRecord(summary: RunSummary): BandwidthBaselineRecord | null {
  const bandwidth = summary.bandwidth;
  if (bandwidth === null) return null;
  if (bandwidth.requests === 0) return null;

  return {
    runId: summary.run_id,
    finishedAt: summary.finished_at,
    requests: bandwidth.requests,
    totalBytes: bandwidth.total_bytes,
    // requests > 0 is already established above, so bytes_per_request is
    // guaranteed non-null here (see BandwidthAggregator.view) — recomputed
    // directly rather than trusting that with a `?? 0` fallback, so a future
    // change to that guarantee cannot silently write a fabricated zero.
    avgBytesPerRequest: bandwidth.total_bytes / bandwidth.requests,
  };
}

export function summarizeBaselines(
  records: readonly BandwidthBaselineRecord[],
  currentRunId?: string,
): BaselineSummary {
  // R2: the baseline itself must come from the same requests > 0 pool as the
  // averages, not the raw list. A zero-request run has avgBytesPerRequest of
  // 0 (or worse, NaN upstream), and picking it as "baseline" turns a later
  // drift calculation (current / baseline) into Infinity or NaN.
  const measured = records.filter((entry) => entry.requests > 0);
  const history = measured.filter((entry) => entry.runId !== currentRunId);

  const totalBytes = measured.reduce((sum, entry) => sum + entry.totalBytes, 0);
  const totalRequests = measured.reduce((sum, entry) => sum + entry.requests, 0);
  const meanOfRuns =
    measured.length === 0
      ? null
      : measured.reduce((sum, entry) => sum + entry.avgBytesPerRequest, 0) / measured.length;

  return {
    baseline: history.length === 0 ? null : (history[history.length - 1] ?? null),
    runs: measured.length,
    byRequest: totalRequests === 0 ? null : totalBytes / totalRequests,
    byRun: meanOfRuns,
  };
}

function isRecord(value: unknown): value is BandwidthBaselineRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.runId === 'string' &&
    typeof candidate.finishedAt === 'string' &&
    typeof candidate.requests === 'number' &&
    typeof candidate.totalBytes === 'number' &&
    typeof candidate.avgBytesPerRequest === 'number'
  );
}
