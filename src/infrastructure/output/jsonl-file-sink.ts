import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';

import { ScrapeError } from '../../core/models/errors.js';
import { type MetricSnapshot } from '../../core/models/snapshot.js';
import { assertValidSnapshot, serializeSnapshotLine } from '../../core/output/serialize.js';
import { type SnapshotSink } from '../../core/output/snapshot-sink.js';

export interface JsonlFileSinkOptions {
  filePath: string;
  /**
   * Validate every row against the schema before writing. On by default: a
   * malformed row in an append-only dataset is expensive to find later.
   */
  validate?: boolean | undefined;
}

/**
 * Append-only JSONL writer.
 *
 * - opens with `a`, so re-running against an existing file adds to it
 * - one UTF-8 JSON object per line, never rewritten or de-duplicated
 * - respects stream backpressure by awaiting `drain`
 * - surfaces write errors instead of dropping rows
 *
 * Repeated scrapes of the same video are supposed to produce repeated rows:
 * `video_id` is an attribute of an observation here, not a primary key.
 */
export class JsonlFileSink implements SnapshotSink {
  readonly location: string;
  private readonly validate: boolean;
  private stream: WriteStream | null = null;
  private streamError: Error | null = null;
  private rows = 0;
  private closed = false;

  constructor(options: JsonlFileSinkOptions) {
    this.location = path.resolve(options.filePath);
    this.validate = options.validate ?? true;
  }

  get rowsWritten(): number {
    return this.rows;
  }

  /** Creates the parent directory and opens the file. Called lazily by `write`. */
  async open(): Promise<void> {
    if (this.stream !== null) return;

    try {
      await mkdir(path.dirname(this.location), { recursive: true });
    } catch (error) {
      throw new ScrapeError({
        code: 'output_error',
        message: `cannot create output directory for "${this.location}": ${errorMessage(error)}`,
        cause: error,
      });
    }

    const stream = createWriteStream(this.location, { flags: 'a', encoding: 'utf8' });
    stream.on('error', (error: Error) => {
      this.streamError = error;
    });

    try {
      await once(stream, 'open');
    } catch (error) {
      throw new ScrapeError({
        code: 'output_error',
        message: `cannot open output file "${this.location}": ${errorMessage(error)}`,
        cause: error,
      });
    }

    this.stream = stream;
  }

  async write(snapshot: MetricSnapshot): Promise<void> {
    if (this.closed) {
      throw new ScrapeError({
        code: 'output_error',
        message: `output "${this.location}" is already closed`,
      });
    }

    const row = this.validate ? assertValidSnapshot(snapshot) : snapshot;
    await this.open();
    this.throwIfFailed();

    const stream = this.stream;
    if (stream === null) {
      throw new ScrapeError({
        code: 'output_error',
        message: `output "${this.location}" is not open`,
      });
    }

    const line = `${serializeSnapshotLine(row)}\n`;
    const flushed = stream.write(line);
    if (!flushed) {
      // Backpressure: wait for the kernel buffer to drain before queueing more.
      await once(stream, 'drain');
    }
    this.throwIfFailed();
    this.rows += 1;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    const stream = this.stream;
    if (stream === null) return;

    await new Promise<void>((resolve, reject) => {
      stream.end((): void => {
        resolve();
      });
      stream.once('error', reject);
    });

    this.throwIfFailed();
  }

  private throwIfFailed(): void {
    if (this.streamError !== null) {
      const error = this.streamError;
      throw new ScrapeError({
        code: 'output_error',
        message: `writing to "${this.location}" failed: ${error.message}`,
        cause: error,
      });
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
