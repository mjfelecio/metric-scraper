import { type SessionProgress } from '../app/scrape-session.js';
import { type CycleSummary } from '../core/models/session-summary.js';
import { type RunProgress } from '../core/runner/types.js';
import { formatDuration } from '../core/schedule/duration.js';

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

/**
 * Throttled session progress line on stderr.
 *
 * Same conventions as {@link ProgressReporter} — stderr, so stdout stays clean
 * for the summary; `\r` rewriting on a TTY and one line per update otherwise,
 * so piping a long session to a file produces a readable log rather than a
 * single kilometre-long line.
 */
export class SessionProgressReporter {
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

  update(progress: SessionProgress, force = false): void {
    if (!this.enabled) return;
    const now = Date.now();
    if (!force && now - this.lastRenderAt < this.intervalMs) return;
    this.lastRenderAt = now;

    const parts = [
      `cycle ${progress.cycle}${progress.plannedCycles === null ? '' : `/${progress.plannedCycles}`}`,
    ];

    if (progress.state === 'waiting') {
      const waitMs = progress.nextCycleAt === null ? 0 : progress.nextCycleAt - now;
      parts.push(`waiting${waitMs > 0 ? ` ${formatDuration(waitMs)}` : ''}`);
    } else {
      parts.push(`${progress.processed}/${progress.total}`);
    }

    parts.push(`${progress.completed} done`);
    parts.push(`${progress.requestsPerMinute.toFixed(0)} req/min`);
    parts.push(`peak ${progress.peakRequestsPerMinute.toFixed(0)}`);
    if (progress.sustainedTargetMs > 0) {
      parts.push(`held ${formatDuration(progress.sustainedTargetMs)}`);
    }
    parts.push(formatDuration(progress.elapsedMs));
    if (progress.stalled) parts.push('STALLED');

    this.write(`  ${parts.join('  ·  ')}`);
  }

  /** Prints a permanent line per cycle, so a long session leaves a readable trail. */
  cycleFinished(cycle: CycleSummary): void {
    if (!this.enabled) return;
    this.clearLine();

    const totals = cycle.summary?.totals;
    const detail =
      cycle.error !== null
        ? `FAILED [${cycle.error.code}] ${cycle.error.message}`
        : `${totals?.requests ?? 0} req, ${totals?.successes ?? 0} ok, ` +
          `${totals?.failures ?? 0} failed, ` +
          `${(cycle.summary?.throughput.requests_per_minute ?? 0).toFixed(0)} req/min`;

    const flags = [
      cycle.lag_ms > 0 ? `late ${formatDuration(cycle.lag_ms)}` : null,
      cycle.overran ? 'overran interval' : null,
    ].filter((flag): flag is string => flag !== null);

    this.stream.write(
      `  cycle ${String(cycle.cycle).padStart(3, ' ')}  ${detail}` +
        `${flags.length === 0 ? '' : `  (${flags.join(', ')})`}\n`,
    );
  }

  done(): void {
    this.clearLine();
  }

  private write(line: string): void {
    if (this.stream.isTTY) {
      this.stream.write(`\r${line.padEnd(110, ' ')}`);
      this.wroteLine = true;
    } else {
      this.stream.write(`${line}\n`);
    }
  }

  private clearLine(): void {
    if (this.enabled && this.wroteLine && this.stream.isTTY) {
      this.stream.write('\n');
      this.wroteLine = false;
    }
  }
}
