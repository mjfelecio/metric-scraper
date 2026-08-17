import { buildRunner, type RunnerOverrides } from '../app/composition.js';
import { loadConfig, type AppConfig } from '../config/env.js';
import { parseInput } from '../core/input/parse-input.js';
import { ScrapeError } from '../core/models/errors.js';
import { isFatalInputIssue, type InputFormat, type ParsedInput } from '../core/models/input.js';
import { type Platform } from '../core/models/platform.js';
import { type RunSummary } from '../core/models/run-summary.js';
import { formatRunSummary } from '../core/runner/format-summary.js';
import { loadInputFile } from '../infrastructure/input/file-input-loader.js';
import { JsonlFileSink } from '../infrastructure/output/jsonl-file-sink.js';
import { resolveRunPaths, writeRunSummary } from '../infrastructure/output/run-paths.js';
import { createLogger, type LogLevel } from '../infrastructure/logging/pino-logger.js';
import { createDefaultUrlNormalizerRegistry } from '../platforms/index.js';

import { ProgressReporter } from './progress.js';

export interface ExecuteBatchOptions {
  /** `null` accepts a mixed batch and routes each URL by its host. */
  platform: Platform | null;
  /** Batch file path. Mutually exclusive with `urls`. */
  inputPath?: string | undefined;
  urls?: readonly string[] | undefined;
  format?: InputFormat | 'auto' | undefined;
  overrides?: RunnerOverrides | undefined;
  outputDir?: string | undefined;
  outputFile?: string | undefined;
  /** Abort when any input entry is rejected, instead of continuing. */
  strict?: boolean | undefined;
  /** Print the summary as JSON on stdout instead of a formatted block. */
  json?: boolean | undefined;
  progress?: boolean | undefined;
  logLevel?: LogLevel | undefined;
  config?: AppConfig | undefined;
}

export interface ExecuteBatchResult {
  summary: RunSummary;
  parsed: ParsedInput;
}

/**
 * Shared implementation behind `scraper tiktok`, `scraper instagram` and
 * `scraper run`. The commands differ only in how they gather these options.
 */
export async function executeBatch(options: ExecuteBatchOptions): Promise<ExecuteBatchResult> {
  const config = options.config ?? loadConfig();
  const logger = createLogger({ level: options.logLevel ?? config.logLevel });

  const parsed = await gatherInput(options);
  reportInputIssues(parsed, options.strict ?? false);

  const startedAt = new Date();
  const paths = resolveRunPaths({
    outputDir: options.outputDir ?? config.outputDir,
    platform: options.platform,
    startedAt,
    snapshotsPath: options.outputFile ?? null,
  });

  const sink = new JsonlFileSink({ filePath: paths.snapshots });
  const built = await buildRunner({ config, logger, sink, overrides: options.overrides });

  const progress = new ProgressReporter({
    enabled: options.progress !== false && options.json !== true,
  });

  process.stderr.write(
    `\nScraping ${parsed.records.length} URL(s) ` +
      `(platform: ${options.platform ?? 'auto'}, concurrency: ${built.concurrency}, ` +
      `target: ${built.targetRpm} req/min)\n`,
  );

  const result = await built.runner.run(parsed.records, {
    platform: options.platform,
    summaryPath: paths.summary,
    counts: {
      candidates: parsed.totalCandidates,
      accepted: parsed.records.length,
      rejected: parsed.issues.length,
    },
    onProgress: (update) => progress.update(update),
  });
  progress.done();

  await writeRunSummary(paths.summary, result.summary);

  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
  } else {
    process.stdout.write(formatRunSummary(result.summary));
  }

  if (result.fatalError !== null) {
    throw result.fatalError;
  }

  return { summary: result.summary, parsed };
}

async function gatherInput(options: ExecuteBatchOptions): Promise<ParsedInput> {
  const registry = createDefaultUrlNormalizerRegistry();

  if (options.urls !== undefined && options.urls.length > 0) {
    return parseInput(options.urls.join('\n'), {
      registry,
      format: 'text',
      expectedPlatform: options.platform,
    });
  }

  if (options.inputPath === undefined) {
    throw new ScrapeError({
      code: 'config_error',
      message: 'no input provided: pass a batch file or a list of URLs',
    });
  }

  return loadInputFile(options.inputPath, {
    registry,
    format: options.format ?? 'auto',
    expectedPlatform: options.platform,
  });
}

/**
 * Rejected input is always reported. `--strict` turns it into a hard stop;
 * otherwise the run continues with what was usable, and the counts appear in
 * the run summary.
 */
function reportInputIssues(parsed: ParsedInput, strict: boolean): void {
  const fatal = parsed.issues.find(isFatalInputIssue);
  if (fatal !== undefined) {
    throw new ScrapeError({ code: 'config_error', message: `invalid input — ${fatal.message}` });
  }

  if (parsed.issues.length > 0) {
    process.stderr.write(`\n${parsed.issues.length} input entr(ies) rejected:\n`);
    for (const issue of parsed.issues.slice(0, 20)) {
      const location = issue.position === null ? '' : ` (position ${issue.position})`;
      process.stderr.write(`  [${issue.code}]${location} ${issue.message}\n`);
    }
    if (parsed.issues.length > 20) {
      process.stderr.write(`  … and ${parsed.issues.length - 20} more\n`);
    }
  }

  if (strict && parsed.issues.length > 0) {
    throw new ScrapeError({
      code: 'config_error',
      message: `--strict: refusing to run with ${parsed.issues.length} rejected input entr(ies)`,
    });
  }

  if (parsed.records.length === 0) {
    throw new ScrapeError({
      code: 'config_error',
      message: 'no usable URLs in the supplied input',
    });
  }
}
