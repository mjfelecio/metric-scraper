import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/** One completed run's bandwidth, appended when the run finishes. */
export interface BandwidthBaselineRecord {
  readonly runId: string;
  readonly finishedAt: string;
  readonly requests: number;
  readonly totalBytes: number;
  readonly avgBytesPerRequest: number;
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

/** Reads the append-only log, skipping any line that is not usable. */
export async function readBaselines(path_: string): Promise<BandwidthBaselineRecord[]> {
  let raw: string;
  try {
    raw = await readFile(path_, 'utf8');
  } catch {
    // No history yet is the normal first-run state, not an error.
    return [];
  }

  const records: BandwidthBaselineRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) records.push(parsed);
    } catch {
      // A truncated final line is expected if a run was killed mid-write.
      continue;
    }
  }
  return records;
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
