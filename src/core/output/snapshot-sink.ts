import { type MetricSnapshot } from '../models/snapshot.js';

/**
 * Where finished rows go.
 *
 * Append-only by contract: a sink must never update or de-duplicate rows.
 * Scraping the same video twice is supposed to produce two rows — that is the
 * time series this project exists to collect.
 */
export interface SnapshotSink {
  write(snapshot: MetricSnapshot): Promise<void>;
  /** Flush and release resources. Safe to call more than once. */
  close(): Promise<void>;
  readonly rowsWritten: number;
  /** Where rows landed, for the run summary. `null` for non-file sinks. */
  readonly location: string | null;
}

/** Collects rows in memory. Used by tests and by the web dashboard preview. */
export class MemorySnapshotSink implements SnapshotSink {
  readonly snapshots: MetricSnapshot[] = [];
  readonly location = null;

  get rowsWritten(): number {
    return this.snapshots.length;
  }

  write(snapshot: MetricSnapshot): Promise<void> {
    this.snapshots.push(snapshot);
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** Writes to several sinks at once (e.g. a file plus an in-memory buffer). */
export class FanOutSnapshotSink implements SnapshotSink {
  private readonly sinks: readonly SnapshotSink[];

  constructor(sinks: readonly SnapshotSink[]) {
    this.sinks = sinks;
  }

  get rowsWritten(): number {
    return this.sinks[0]?.rowsWritten ?? 0;
  }

  get location(): string | null {
    return this.sinks.find((sink) => sink.location !== null)?.location ?? null;
  }

  async write(snapshot: MetricSnapshot): Promise<void> {
    for (const sink of this.sinks) {
      await sink.write(snapshot);
    }
  }

  async close(): Promise<void> {
    for (const sink of this.sinks) {
      await sink.close();
    }
  }
}
