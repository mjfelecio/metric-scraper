import { runSession, type SessionProgress } from '../app/scrape-session.js';
import { type RunnerOverrides } from '../app/composition.js';
import { loadConfig, type AppConfig } from '../config/env.js';
import { ScrapeError } from '../core/models/errors.js';
import { type InputFormat } from '../core/models/input.js';
import { type Platform } from '../core/models/platform.js';
import { type SessionSummary } from '../core/models/session-summary.js';
import { formatSessionSummary } from '../core/runner/format-session-summary.js';
import { formatDuration } from '../core/schedule/duration.js';
import { resolveSessionPaths } from '../infrastructure/output/run-paths.js';
import { createLogger, type LogLevel } from '../infrastructure/logging/pino-logger.js';

import { gatherInput, reportInputIssues } from './execute-batch.js';
import { SessionProgressReporter } from './progress.js';

export interface ExecuteSessionOptions {
  platform: Platform | null;
  inputPath?: string | undefined;
  urls?: readonly string[] | undefined;
  format?: InputFormat | 'auto' | undefined;
  overrides?: RunnerOverrides | undefined;
  outputDir?: string | undefined;
  outputFile?: string | undefined;
  strict?: boolean | undefined;
  json?: boolean | undefined;
  progress?: boolean | undefined;
  logLevel?: LogLevel | undefined;
  config?: AppConfig | undefined;
  schedule: {
    intervalMs: number;
    durationMs: number | null;
    maxCycles: number | null;
  };
}

/**
 * Shared implementation behind `--watch` for every scrape command.
 *
 * Mirrors {@link executeBatch}: same input handling, same output conventions
 * (summary on stdout, progress and logs on stderr), same exit-code rule that
 * scrape failures are data rather than run-level errors. It differs only in
 * repeating the batch on a schedule and reporting the session as a whole.
 */
export async function executeSession(options: ExecuteSessionOptions): Promise<SessionSummary> {
  const config = options.config ?? loadConfig();
  const logger = createLogger({ level: options.logLevel ?? config.logLevel });

  const parsed = await gatherInput(options);
  reportInputIssues(parsed, options.strict ?? false);

  const startedAt = new Date();
  const paths = resolveSessionPaths({
    outputDir: options.outputDir ?? config.outputDir,
    platform: options.platform,
    startedAt,
    snapshotsPath: options.outputFile ?? null,
  });

  const { schedule } = options;
  const concurrency = options.overrides?.concurrency ?? config.concurrency;
  const targetRpm = options.overrides?.targetRpm ?? config.targetRpm;

  const limits = [
    schedule.durationMs === null ? null : `for ${formatDuration(schedule.durationMs)}`,
    schedule.maxCycles === null ? null : `max ${schedule.maxCycles} cycles`,
  ].filter((entry): entry is string => entry !== null);

  process.stderr.write(
    `\nWatching ${parsed.records.length} URL(s) ` +
      `(platform: ${options.platform ?? 'auto'}, concurrency: ${concurrency}, ` +
      `target: ${targetRpm} req/min, interval: ${
        schedule.intervalMs === 0 ? 'back-to-back' : formatDuration(schedule.intervalMs)
      }${limits.length === 0 ? '' : `, ${limits.join(', ')}`})\n` +
      `Output: ${paths.snapshots}\n` +
      `Press Ctrl-C to stop; the cycle in flight finishes and the session still reports.\n`,
  );

  const reporter = new SessionProgressReporter({
    enabled: options.progress !== false && options.json !== true,
  });

  // First Ctrl-C asks the session to wind down so the in-flight cycle finishes
  // and the summary is still written; a second one is taken to mean "now".
  const controller = new AbortController();
  let interrupted = false;
  const onInterrupt = (): void => {
    if (interrupted) {
      process.stderr.write('\nSecond interrupt — exiting immediately.\n');
      process.exit(130);
    }
    interrupted = true;
    reporter.done();
    process.stderr.write('\nStopping after the current cycle…\n');
    controller.abort(new ScrapeError({ code: 'cancelled', message: 'interrupted by operator' }));
  };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);

  let summary: SessionSummary;
  try {
    summary = await runSession({
      records: parsed.records,
      platform: options.platform,
      counts: {
        candidates: parsed.totalCandidates,
        accepted: parsed.records.length,
        rejected: parsed.issues.length,
      },
      config,
      logger,
      ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
      schedule,
      paths,
      signal: controller.signal,
      onProgress: (progress: SessionProgress) => reporter.update(progress),
      onCycleEnd: (cycle) => {
        reporter.cycleFinished(cycle);
      },
    });
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);
    reporter.done();
  }

  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(formatSessionSummary(summary));
  }

  // Same rule as a single run: scrape failures are data, but a run-level
  // failure (an unwritable output) is an error and must exit non-zero. The
  // summary is printed first either way, so the run is never silent.
  if (summary.schedule.stop_reason === 'fatal') {
    throw new ScrapeError({
      code: 'output_error',
      message: 'session stopped early: output could not be written',
    });
  }

  return summary;
}
