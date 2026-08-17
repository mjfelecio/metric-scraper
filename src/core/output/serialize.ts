import { ScrapeError } from '../models/errors.js';
import {
  MetricSnapshotSchema,
  SNAPSHOT_FIELD_ORDER,
  type MetricSnapshot,
} from '../models/snapshot.js';

/**
 * Serializes one snapshot to a single JSONL line (no trailing newline).
 *
 * Keys are emitted in the canonical column order so that files diff cleanly
 * and column-oriented consumers see a stable shape. `JSON.stringify` escapes
 * any embedded newline, so one snapshot can never become two rows.
 */
export function serializeSnapshotLine(snapshot: MetricSnapshot): string {
  const ordered: Record<string, unknown> = {};
  for (const key of SNAPSHOT_FIELD_ORDER) {
    ordered[key] = snapshot[key];
  }
  return JSON.stringify(ordered);
}

export function assertValidSnapshot(snapshot: MetricSnapshot): MetricSnapshot {
  const parsed = MetricSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new ScrapeError({
      code: 'output_error',
      message: `refusing to write an invalid snapshot (${detail})`,
    });
  }
  return parsed.data;
}

/** Inverse of {@link serializeSnapshotLine}; used when reading a run back. */
export function parseSnapshotLine(line: string): MetricSnapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (error) {
    throw new ScrapeError({
      code: 'output_error',
      message: `JSONL line is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      cause: error,
    });
  }
  return MetricSnapshotSchema.parse(raw);
}
