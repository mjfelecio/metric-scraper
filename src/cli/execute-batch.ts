import { appendBandwidthBaseline } from '../app/bandwidth-refresh.js';
import {
  buildRunner,
  createProxySupply,
  type BuiltRunner,
  type RunnerOverrides,
} from '../app/composition.js';
import { loadConfig, type AppConfig } from '../config/env.js';
import { parseInput } from '../core/input/parse-input.js';
import { ScrapeError } from '../core/models/errors.js';
import { isFatalInputIssue, type InputFormat, type ParsedInput } from '../core/models/input.js';
import { type Platform } from '../core/models/platform.js';
import { type RunSummary } from '../core/models/run-summary.js';
import { formatRunSummary } from '../core/runner/format-summary.js';
import { loadInputFile } from '../infrastructure/input/file-input-loader.js';
import { JsonlFileSink } from '../infrastructure/output/jsonl-file-sink.js';
import { ProxyEventLog } from '../infrastructure/output/proxy-event-log.js';
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
  const strict = options.strict ?? false;
  if (parsed.issues.some(isFatalInputIssue) || (strict && parsed.issues.length > 0)) {
    reportInputIssues(parsed, strict);
  }

  const startedAt = new Date();
  const paths = resolveRunPaths({
    outputDir: options.outputDir ?? config.outputDir,
    platform: options.platform,
    startedAt,
    snapshotsPath: options.outputFile ?? null,
  });

  const sink = new JsonlFileSink({ filePath: paths.snapshots });
  const proxyEvents = new ProxyEventLog({ filePath: paths.proxyEvents, logger });
  const proxySupply = createProxySupply(
    config,
    logger,
    (event) => {
      proxyEvents.record(event);
    },
    options.overrides?.concurrency ?? config.concurrency,
  );
  await proxySupply.source?.start();
  let built: BuiltRunner | null = null;

  try {
    built = await buildRunner({
      config,
      logger,
      sink,
      overrides: options.overrides,
      proxyProvider: proxySupply.provider,
    });
    const prepared =
      built.inputPreparer === undefined
        ? {
            items: parsed.records.map((record) => ({
              kind: 'ready' as const,
              record,
              resolution: null,
            })),
            issues: [],
          }
        : await built.inputPreparer.prepare(parsed.records);
    const preparedParsed: ParsedInput = {
      ...parsed,
      records: prepared.items.map((item) => item.record),
      issues: [...parsed.issues, ...prepared.issues],
    };
    reportInputIssues(preparedParsed, strict);

    const progress = new ProgressReporter({
      enabled: options.progress !== false && options.json !== true,
    });

    process.stderr.write(
      `\nScraping ${prepared.items.length} URL(s) ` +
        `(platform: ${options.platform ?? 'auto'}, concurrency: ${built.concurrency}, ` +
        `target: ${built.targetRpm} req/min)\n`,
    );

    const result = await built.runner.run(prepared.items, {
      platform: options.platform,
      summaryPath: paths.summary,
      counts: {
        candidates: parsed.totalCandidates,
        accepted: prepared.items.length,
        rejected: preparedParsed.issues.length,
      },
      onProgress: (update) => progress.update(update),
    });
    progress.done();

    await writeRunSummary(paths.summary, result.summary);
    // R8: the CLI path completes a `RunSummary` exactly like the web
    // dashboard's one-shot run, so it earns a line in the same cross-run
    // baseline history — design doc §3.5, "one line per completed run".
    // `appendBandwidthBaseline` swallows its own errors (logging instead), so
    // this can never turn a bad baseline write into a failed batch.
    await appendBandwidthBaseline(result.summary, {
      outputDir: options.outputDir ?? config.outputDir,
      logger,
    });

    if (options.json === true) {
      process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
    } else {
      process.stdout.write(formatRunSummary(result.summary));
    }

    if (result.fatalError !== null) {
      throw result.fatalError;
    }

    return { summary: result.summary, parsed: preparedParsed };
  } finally {
    try {
      await built?.dispose();
    } catch (error) {
      logger.warn(
        { message: error instanceof Error ? error.message : String(error) },
        'could not close run HTTP transport',
      );
    }
    proxySupply.source?.stop();
    await proxyEvents.close();
  }
}

/** Shared with `execute-session.ts` so watch mode parses input identically. */
export async function gatherInput(options: {
  platform: Platform | null;
  inputPath?: string | undefined;
  urls?: readonly string[] | undefined;
  format?: InputFormat | 'auto' | undefined;
}): Promise<ParsedInput> {
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
export function reportInputIssues(parsed: ParsedInput, strict: boolean): void {
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
