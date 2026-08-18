import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { type Logger, nullLogger } from '../../core/logging/logger.js';
import { type ProxyEvent } from '../../core/scraper/pool-ports.js';

export interface ProxyEventLogOptions {
  filePath: string;
  /** Written onto every row, e.g. `{ run_id }` or `{ session_id }`. */
  context?: Readonly<Record<string, string>> | undefined;
  logger?: Logger | undefined;
}

/**
 * Append-only record of proxy health transitions.
 *
 * This is the artifact that answers a question after the fact: which proxies
 * went bad during last night's run, when, why, and when they came back. The
 * pool only ever holds the present, and a run summary only holds the end state,
 * so without this the middle of a run is unrecoverable.
 *
 * Two deliberate differences from {@link JsonlFileSink}, which writes the actual
 * dataset:
 *
 * - **Never fatal.** A scrape row that cannot be written stops the run, because
 *   losing data is unacceptable. An observability row that cannot be written
 *   must not: the run is still doing its job. Failures are logged once and the
 *   log then quietly stands down.
 * - **Fire and forget.** `record` is called synchronously from inside the pool,
 *   on the path that hands out leases. It buffers into the stream and returns;
 *   it never awaits, so rotation cannot be slowed by a disk.
 *
 * Volume is bounded by state changes rather than by requests — a bad ten-minute
 * run produces tens of rows — which is what makes keeping it always-on cheap.
 */
export class ProxyEventLog {
  readonly location: string;
  private readonly context: Readonly<Record<string, string>>;
  private readonly logger: Logger;
  private stream: WriteStream | null = null;
  private disabled = false;
  private written = 0;

  constructor(options: ProxyEventLogOptions) {
    this.location = path.resolve(options.filePath);
    this.context = options.context ?? {};
    this.logger = options.logger ?? nullLogger;
  }

  get rowsWritten(): number {
    return this.written;
  }

  /** Appends one transition. Safe to call from the pool; never throws. */
  record(event: ProxyEvent): void {
    if (this.disabled) return;

    try {
      const stream = this.open();
      stream.write(`${JSON.stringify(this.toRow(event))}\n`);
      this.written += 1;
    } catch (error) {
      this.standDown(error);
    }
  }

  async close(): Promise<void> {
    const stream = this.stream;
    this.stream = null;
    if (stream === null) return;

    await new Promise<void>((resolve) => {
      stream.end(() => {
        resolve();
      });
    });
  }

  private open(): WriteStream {
    if (this.stream !== null) return this.stream;

    mkdirSync(path.dirname(this.location), { recursive: true });
    // Append, like every other output here: a session reopening the same path
    // between cycles must extend the record rather than truncate it.
    const stream = createWriteStream(this.location, { flags: 'a', encoding: 'utf8' });
    // A stream error arrives asynchronously, so it cannot be caught around the
    // write that caused it — this is the only place it can be handled.
    stream.on('error', (error) => {
      this.standDown(error);
    });
    this.stream = stream;
    return stream;
  }

  private standDown(error: unknown): void {
    if (this.disabled) return;
    this.disabled = true;
    this.stream = null;
    this.logger.warn(
      { path: this.location, message: error instanceof Error ? error.message : String(error) },
      'proxy event log disabled: could not write (the run continues)',
    );
  }

  private toRow(event: ProxyEvent): Record<string, unknown> {
    return {
      at: new Date(event.at).toISOString(),
      ...this.context,
      proxy_id: event.proxyId,
      label: event.label,
      from: event.from,
      to: event.to,
      block_kind: event.blockKind,
      reason: event.reason,
      error_code: event.errorCode,
      consecutive_failures: event.consecutiveFailures,
      eligible_at: event.eligibleAt === null ? null : new Date(event.eligibleAt).toISOString(),
    };
  }
}
