#!/usr/bin/env node
import path from 'node:path';

import { Command, InvalidArgumentError, Option } from 'commander';

import { loadRunConfig, type RunConfig } from '../config/run-config.js';
import { ScrapeError } from '../core/models/errors.js';
import { type RetryPolicyOptions } from '../core/retry/retry-policy.js';
import { type InputFormat } from '../core/models/input.js';
import { type Platform } from '../core/models/platform.js';
import { parseDuration } from '../core/schedule/duration.js';
import { loadConfig } from '../config/env.js';
import { loadInputFile } from '../infrastructure/input/file-input-loader.js';
import { createDefaultUrlNormalizerRegistry } from '../platforms/index.js';

import { executeBatch, type ExecuteBatchOptions } from './execute-batch.js';
import { executeSession } from './execute-session.js';
import { type LogLevel } from '../infrastructure/logging/pino-logger.js';

interface CommonOptions {
  concurrency?: number | undefined;
  targetRpm?: number | undefined;
  burst?: number | undefined;
  httpRpmPerHost?: number | undefined;
  maxAttempts?: number | undefined;
  outputDir?: string | undefined;
  outputFile?: string | undefined;
  format?: InputFormat | 'auto' | undefined;
  strict?: boolean | undefined;
  json?: boolean | undefined;
  progress?: boolean | undefined;
  logLevel?: LogLevel | undefined;
  watch?: boolean | undefined;
  interval?: number | undefined;
  duration?: number | undefined;
  maxCycles?: number | undefined;
}

const program = new Command();

program
  .name('scraper')
  .description(
    [
      'Batch scraper for public engagement metrics on TikTok and Instagram.',
      '',
      'Reads a batch of URLs, scrapes each one, and appends one JSONL snapshot row',
      'per URL — including for failures, which are recorded rather than dropped.',
      '',
      'TikTok canonical video/photo URLs are fetched anonymously from first-party public embed pages.',
      'TikTok vm.tiktok.com and vt.tiktok.com short links are resolved and normalized. Instagram uses anonymous first-party',
      'queries with an optional proxy-bound authenticated fallback for exact old-Reel views.',
    ].join('\n'),
  )
  .version('0.1.0')
  .showHelpAfterError();

function withCommonOptions(command: Command): Command {
  return command
    .option('-c, --concurrency <n>', 'jobs in flight at once', parsePositiveInt)
    .option(
      '-r, --target-rpm <n>',
      'logical scrape jobs admitted per minute (0 = unpaced)',
      parseNonNegativeInt,
    )
    .option(
      '--burst <n>',
      'jobs admissible at once after idle (0 = one second of --target-rpm)',
      parseNonNegativeInt,
    )
    .option(
      '--http-rpm-per-host <n>',
      'ceiling on actual HTTP requests per minute per host, retries included (0 = off)',
      parseNonNegativeInt,
    )
    .option('-a, --max-attempts <n>', 'attempts per URL, including the first', parsePositiveInt)
    .option('-o, --output-dir <dir>', 'directory for JSONL output and run summaries')
    .option('-f, --output-file <file>', 'append to this JSONL file instead of a per-run file')
    .addOption(
      new Option('--format <format>', 'how to parse the input file').choices([
        'auto',
        'text',
        'json',
      ]),
    )
    .option('-w, --watch', 'repeat the batch continuously instead of running it once')
    .option(
      '--interval <duration>',
      'time between cycle starts, e.g. 15m, 30s, or 0 for back-to-back (implies --watch)',
      parseDurationArg,
    )
    .option(
      '--duration <duration>',
      'stop starting new cycles after this much wall clock, e.g. 10m (implies --watch)',
      parsePositiveDurationArg,
    )
    .option('--max-cycles <n>', 'stop after this many cycles (implies --watch)', parsePositiveInt)
    .option('--strict', 'abort if any input entry is rejected')
    .option('--json', 'print the run summary as JSON on stdout')
    .option('--no-progress', 'suppress the progress line')
    .addOption(
      new Option('--log-level <level>', 'structured log level (written to stderr)').choices([
        'trace',
        'debug',
        'info',
        'warn',
        'error',
        'fatal',
        'silent',
      ]),
    );
}

function toExecuteOptions(platform: Platform | null, options: CommonOptions): ExecuteBatchOptions {
  return {
    platform,
    format: options.format,
    strict: options.strict,
    json: options.json,
    progress: options.progress,
    logLevel: options.logLevel,
    outputDir: options.outputDir,
    outputFile: options.outputFile,
    overrides: {
      concurrency: options.concurrency,
      targetRpm: options.targetRpm,
      burst: options.burst,
      httpRpmPerHost: options.httpRpmPerHost,
      ...(options.maxAttempts === undefined ? {} : { retry: { maxAttempts: options.maxAttempts } }),
    },
  };
}

for (const platform of ['tiktok', 'instagram'] as const) {
  withCommonOptions(
    program
      .command(platform)
      .description(`scrape a batch of ${platform} URLs`)
      .argument('<input>', 'path to a newline-delimited .txt or a .json array of URLs'),
  ).action(async (input: string, options: CommonOptions) => {
    const base = { ...toExecuteOptions(platform, options), inputPath: input };
    if (isWatchRequested(options)) {
      await executeSession({ ...base, schedule: resolveSchedule(options) });
      return;
    }
    await executeBatch(base);
  });
}

withCommonOptions(
  program
    .command('run')
    .description('run a batch described by a JSON run config (see config/run.example.json)')
    .argument('<config>', 'path to a run config JSON file'),
).action(async (configPath: string, options: CommonOptions) => {
  const { config, baseDir } = await loadRunConfig(configPath);

  // Every path inside a run config is relative to the config file, so a config
  // behaves the same no matter which directory it is invoked from. Paths given
  // on the command line stay relative to the current directory, as expected.
  const fromConfig = (value: string | null | undefined): string | undefined =>
    value == null ? undefined : path.resolve(baseDir, value);

  const base = toExecuteOptions(config.platform ?? null, options);
  const merged = {
    ...base,
    inputPath: fromConfig(config.input),
    urls: config.urls ?? undefined,
    format: options.format ?? config.format ?? 'auto',
    strict: options.strict ?? config.strict ?? false,
    outputDir: options.outputDir ?? fromConfig(config.outputDir),
    outputFile: options.outputFile ?? fromConfig(config.outputFile),
    overrides: {
      concurrency: options.concurrency ?? config.concurrency ?? undefined,
      targetRpm: options.targetRpm ?? config.targetRpm ?? undefined,
      burst: options.burst ?? config.burst ?? undefined,
      httpRpmPerHost: options.httpRpmPerHost ?? config.httpRpmPerHost ?? undefined,
      retry: {
        ...toRetryOverrides(config.retry),
        ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
      },
    },
  };

  if (isWatchRequested(options, config.watch ?? undefined)) {
    await executeSession({
      ...merged,
      schedule: resolveSchedule(options, {
        interval: toDurationMs(config.interval, 'interval'),
        duration: toDurationMs(config.duration, 'duration', true),
        maxCycles: config.maxCycles ?? undefined,
      }),
    });
    return;
  }

  await executeBatch(merged);
});

program
  .command('validate')
  .description('parse and normalize an input file without scraping anything')
  .argument('<input>', 'path to a .txt or .json batch file')
  .addOption(
    new Option('-p, --platform <platform>', 'require every URL to belong to this platform').choices(
      ['tiktok', 'instagram'],
    ),
  )
  .addOption(
    new Option('--format <format>', 'how to parse the input').choices(['auto', 'text', 'json']),
  )
  .action(
    async (input: string, options: { platform?: Platform; format?: InputFormat | 'auto' }) => {
      const parsed = await loadInputFile(input, {
        registry: createDefaultUrlNormalizerRegistry(),
        format: options.format ?? 'auto',
        expectedPlatform: options.platform ?? null,
      });

      process.stdout.write(
        `\nformat: ${parsed.format}\ncandidates: ${parsed.totalCandidates}\n` +
          `accepted: ${parsed.records.length}\nrejected: ${parsed.issues.length}\n\n`,
      );

      for (const record of parsed.records) {
        process.stdout.write(`  ok   [${record.platform}] ${record.url}\n`);
      }
      for (const issue of parsed.issues) {
        const location = issue.position === null ? '' : `line ${issue.position}: `;
        process.stdout.write(`  fail ${location}[${issue.code}] ${issue.message}\n`);
      }
      process.stdout.write('\n');

      if (parsed.issues.length > 0) {
        process.exitCode = 1;
      }
    },
  );

/**
 * Watch mode is on if it was asked for directly or implied by any of the knobs
 * that only mean something for a repeating session. Typing `--interval 30s` and
 * getting a single run would be a small betrayal.
 */
function isWatchRequested(options: CommonOptions, fromConfig?: boolean): boolean {
  return (
    options.watch === true ||
    options.interval !== undefined ||
    options.duration !== undefined ||
    options.maxCycles !== undefined ||
    fromConfig === true
  );
}

interface ResolvedSchedule {
  intervalMs: number;
  durationMs: number | null;
  maxCycles: number | null;
}

function resolveSchedule(
  options: CommonOptions,
  fromConfig: {
    interval?: number | undefined;
    duration?: number | undefined;
    maxCycles?: number | undefined;
  } = {},
): ResolvedSchedule {
  // Precedence matches every other setting: CLI, then run config, then env.
  const interval = options.interval ?? fromConfig.interval ?? loadConfig().pollIntervalMs;
  // `loadConfig()` above is only reached when neither the flag nor the run
  // config named an interval, so the env default stays the last word.
  const duration = options.duration ?? fromConfig.duration;
  const maxCycles = options.maxCycles ?? fromConfig.maxCycles;

  return {
    intervalMs: interval,
    durationMs: duration ?? null,
    maxCycles: maxCycles ?? null,
  };
}

/** Run-config durations may be a string (`"15m"`) or a raw millisecond number. */
function toDurationMs(
  value: string | number | null | undefined,
  field: string,
  positiveOnly = false,
): number | undefined {
  if (value == null) return undefined;

  let parsed: number;
  if (typeof value === 'number') {
    parsed = value;
  } else {
    try {
      parsed = parseDuration(value);
    } catch (error) {
      throw new ScrapeError({
        code: 'config_error',
        message: `invalid run config — "${field}": ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  if (positiveOnly && parsed <= 0) {
    throw new ScrapeError({
      code: 'config_error',
      message: `invalid run config — "${field}" must be greater than zero`,
    });
  }
  return parsed;
}

function parseDurationArg(value: string): number {
  try {
    return parseDuration(value);
  } catch (error) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * As above, but rejects zero.
 *
 * `--interval 0` is meaningful (back-to-back cycles); `--duration 0` is not —
 * it would start no cycles at all and report an empty session, which is never
 * what someone meant to type.
 */
function parsePositiveDurationArg(value: string): number {
  const parsed = parseDurationArg(value);
  if (parsed <= 0) {
    throw new InvalidArgumentError('expected a duration greater than zero, e.g. 10m');
  }
  return parsed;
}

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError('expected a positive integer');
  }
  return parsed;
}

function parseNonNegativeInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError('expected an integer >= 0');
  }
  return parsed;
}

/** Run-config retry fields are nullish; drop the unset ones before merging. */
function toRetryOverrides(retry: RunConfig['retry']): Partial<RetryPolicyOptions> {
  if (retry == null) return {};
  const overrides: Partial<RetryPolicyOptions> = {};
  if (retry.maxAttempts != null) overrides.maxAttempts = retry.maxAttempts;
  if (retry.initialDelayMs != null) overrides.initialDelayMs = retry.initialDelayMs;
  if (retry.maxDelayMs != null) overrides.maxDelayMs = retry.maxDelayMs;
  if (retry.backoffFactor != null) overrides.backoffFactor = retry.backoffFactor;
  if (retry.jitter != null) overrides.jitter = retry.jitter;
  return overrides;
}

try {
  await program.parseAsync(process.argv);
} catch (error) {
  const scrapeError = ScrapeError.from(error);
  process.stderr.write(`\nerror [${scrapeError.code}]: ${scrapeError.message}\n\n`);
  process.exitCode = 1;
}
