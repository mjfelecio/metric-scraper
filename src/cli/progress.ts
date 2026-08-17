import { type RunProgress } from '../core/runner/types.js';

/**
 * Throttled progress line on stderr.
 *
 * stderr on purpose: stdout carries the run summary (optionally as JSON), so a
 * run can be piped into another tool without progress noise corrupting it.
 */
export class ProgressReporter {
  private lastRenderAt = 0;
  private readonly intervalMs: number;
  private readonly stream: NodeJS.WriteStream;
  private readonly enabled: boolean;
  private wroteLine = false;

  constructor(options: { enabled: boolean; intervalMs?: number; stream?: NodeJS.WriteStream }) {
    this.enabled = options.enabled;
    this.intervalMs = options.intervalMs ?? 200;
    this.stream = options.stream ?? process.stderr;
  }

  update(progress: RunProgress, force = false): void {
    if (!this.enabled) return;
    const now = Date.now();
    if (!force && now - this.lastRenderAt < this.intervalMs) return;
    this.lastRenderAt = now;

    const pct = progress.total === 0 ? 0 : Math.round((progress.processed / progress.total) * 100);
    const line =
      `  ${String(pct).padStart(3, ' ')}%  ` +
      `${progress.processed}/${progress.total} processed  ` +
      `${progress.successful} ok  ${progress.failed} failed  ` +
      `${progress.throughputPerMinute.toFixed(0)} req/min  ` +
      `${(progress.elapsedMs / 1000).toFixed(1)}s`;

    if (this.stream.isTTY) {
      this.stream.write(`\r${line.padEnd(90, ' ')}`);
      this.wroteLine = true;
    } else {
      this.stream.write(`${line}\n`);
    }
  }

  done(): void {
    if (this.enabled && this.wroteLine && this.stream.isTTY) {
      this.stream.write('\n');
    }
  }
}
