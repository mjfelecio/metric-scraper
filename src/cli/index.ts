#!/usr/bin/env node
import path from 'node:path';

import { Command, InvalidArgumentError, Option } from 'commander';

import { loadRunConfig, type RunConfig } from '../config/run-config.js';
import { ScrapeError } from '../core/models/errors.js';
import { type RetryPolicyOptions } from '../core/retry/retry-policy.js';
import { type InputFormat } from '../core/models/input.js';
import { type Platform } from '../core/models/platform.js';
import { loadInputFile } from '../infrastructure/input/file-input-loader.js';
import { createDefaultUrlNormalizerRegistry } from '../platforms/index.js';

import { executeBatch, type ExecuteBatchOptions } from './execute-batch.js';
import { type LogLevel } from '../infrastructure/logging/pino-logger.js';

interface CommonOptions {
  concurrency?: number | undefined;
  targetRpm?: number | undefined;
  maxAttempts?: number | undefined;
  outputDir?: string | undefined;
  outputFile?: string | undefined;
  format?: InputFormat | 'auto' | undefined;
  strict?: boolean | undefined;
  json?: boolean | undefined;
  progress?: boolean | undefined;
  logLevel?: LogLevel | undefined;
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
      'TikTok short links are not resolved yet. Instagram acquisition remains a',
      'placeholder and returns status=error / not_implemented.',
    ].join('\n'),
  )
  .version('0.1.0')
  .showHelpAfterError();

function withCommonOptions(command: Command): Command {
  return command
    .option('-c, --concurrency <n>', 'jobs in flight at once', parsePositiveInt)
    .option(
      '-r, --target-rpm <n>',
      'requests-per-minute ceiling (0 = unpaced)',
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
    await executeBatch({ ...toExecuteOptions(platform, options), inputPath: input });
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
  await executeBatch({
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
      retry: {
        ...toRetryOverrides(config.retry),
        ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
      },
    },
  });
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
