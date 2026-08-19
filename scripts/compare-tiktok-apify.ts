/**
 * Compares the production TikTok scraper with an Apify Actor on the same URLs.
 *
 * The question: does Apify give us *more granular* TikTok view counts than we
 * already collect, or does it return the same public, rounded numbers?
 *
 * This is a benchmark and a decision tool. It is not, and must not become, a
 * production Apify integration — nothing under `src/` imports any of it, and
 * `tsconfig.build.json` compiles only `src/`, so none of this reaches `dist/`.
 *
 *   pnpm compare:tiktok-apify -- data/apify-benchmark.txt
 *   pnpm compare:tiktok-apify -- data/apify-benchmark.txt --execute
 *
 * Dry run is the default and is entirely offline: it contacts neither Apify nor
 * TikTok. A paid run requires `--execute` AND an `APIFY_TOKEN` in the
 * environment, and refuses to start if either the URL count or the charge cap
 * is out of bounds. The token is read from the environment only — never from a
 * flag, never written to an artifact, never placed in a URL.
 */
import { Command, InvalidArgumentError } from 'commander';

import { ScrapeError } from '../src/core/models/errors.js';
import { FetchHttpClient } from '../src/infrastructure/http/fetch-http-client.js';
import { createLogger, type LogLevel } from '../src/infrastructure/logging/pino-logger.js';
import { TikTokScraper } from '../src/platforms/tiktok/tiktok-scraper.js';

import { resolveComparisonPaths, writeArtifacts } from './apify-comparison/artifacts.js';
import { adapterFor, supportedActorIds } from './apify-comparison/adapter-registry.js';
import { CountingHttpClient } from './apify-comparison/counting-http-client.js';
import { FetchApifyTransport } from './apify-comparison/fetch-apify-transport.js';
import { loadTargets } from './apify-comparison/load-targets.js';
import {
  DEFAULT_ACTOR_ID,
  DEFAULT_MAX_CHARGE_USD,
  DEFAULT_MAX_URLS,
  HARD_MAX_CHARGE_USD,
  HARD_MAX_URLS,
  resolveOptions,
} from './apify-comparison/options.js';
import { runComparison, type DryRunPlan } from './apify-comparison/run-comparison.js';

const program = new Command();

program
  .name('compare:tiktok-apify')
  .description(
    [
      'Research benchmark: our TikTok scraper vs. an Apify Actor on identical URLs.',
      '',
      'Dry run by default — no network, no charge. Pass --execute for a paid run,',
      'with APIFY_TOKEN set in the environment only.',
    ].join('\n'),
  )
  .argument('<input>', 'newline-delimited .txt or .json array of TikTok post URLs')
  .option('--execute', 'actually start a paid Apify run (default: dry run, offline)')
  .option(
    '--actor <id>',
    `Actor to benchmark (default: ${DEFAULT_ACTOR_ID}, supported: ${supportedActorIds().join(', ')})`,
  )
  .option(
    '--max-charge-usd <usd>',
    `dollar ceiling for the run (default: ${DEFAULT_MAX_CHARGE_USD}, hard max: ${HARD_MAX_CHARGE_USD})`,
    parsePositiveFloat,
  )
  .option(
    '--max-urls <n>',
    `billable unique URLs allowed (default: ${DEFAULT_MAX_URLS}, hard max: ${HARD_MAX_URLS})`,
    parsePositiveInt,
  )
  .option('--local-timeout-ms <ms>', 'per-URL timeout for the local scraper', parsePositiveInt)
  .option('--apify-timeout-ms <ms>', 'overall deadline for the Apify side', parsePositiveInt)
  .option('--output-dir <dir>', 'where to write artifacts (default: ./output/comparisons)')
  .option('--log-level <level>', 'structured log level written to stderr', 'warn')
  .action(async (input: string, flags: Record<string, unknown>) => {
    const options = resolveOptions({
      inputPath: input,
      execute: flags.execute === true,
      actor: flags.actor as string | undefined,
      maxChargeUsd: flags.maxChargeUsd as number | undefined,
      maxUrls: flags.maxUrls as number | undefined,
      localTimeoutMs: flags.localTimeoutMs as number | undefined,
      apifyTimeoutMs: flags.apifyTimeoutMs as number | undefined,
      outputDir: flags.outputDir as string | undefined,
    });

    const logger = createLogger({ level: (flags.logLevel as LogLevel | undefined) ?? 'warn' });
    const loaded = await loadTargets(options.inputPath, { maxUrls: options.maxUrls });

    const http = new CountingHttpClient(
      new FetchHttpClient({ defaultTimeoutMs: options.localTimeoutMs }),
    );

    const outcome = await runComparison({
      options,
      loaded,
      adapter: adapterFor(options.actor.input),
      scraper: new TikTokScraper(),
      http,
      logger,
      ...(options.execute ? { transport: new FetchApifyTransport() } : {}),
    });

    if (outcome.mode === 'dry-run') {
      process.stdout.write(formatPlan(outcome.plan));
      return;
    }

    const paths = resolveComparisonPaths(options.outputDir, new Date());
    await writeArtifacts(paths, {
      manifest: {
        inputPath: options.inputPath,
        targets: loaded.targets,
        issues: loaded.issues,
        duplicatesCollapsed: loaded.duplicatesCollapsed,
      },
      localSnapshots: outcome.localSnapshots,
      apifyDataset: outcome.apifyDataset,
      rows: outcome.rows,
      // `summary` and `report` are always populated in execute mode; the casts
      // are avoided by checking rather than asserting.
      summary: outcome.summary ?? failMissing('summary'),
      report: outcome.report ?? failMissing('report'),
      secrets: options.token === null ? [] : [options.token],
    });

    process.stdout.write(`\nArtifacts written to ${paths.dir}\n`);
    if (outcome.apifyError !== null) {
      process.stderr.write(`\nApify side failed: ${outcome.apifyError}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`\n${outcome.report ?? ''}\n`);
  });

/**
 * What dry run prints.
 *
 * Everything an operator needs to decide whether the paid run is the right one:
 * how many URLs will actually be billed, which Actor, what the ceiling is, and
 * the exact input — so a re-enabled media download is visible before it is paid
 * for rather than after.
 */
export function formatPlan(plan: DryRunPlan): string {
  const lines = [
    '',
    'DRY RUN — no Apify request was made and nothing was charged.',
    '',
    `  actor:              ${plan.actorId}  (path id: ${plan.actorPathId})`,
    `  billable URLs:      ${plan.billableUrls} of a permitted ${plan.maxUrls}`,
    `  charge cap:         $${plan.maxChargeUsd}`,
    `  duplicates dropped: ${plan.duplicatesCollapsed}`,
    `  rejected inputs:    ${plan.rejectedInputs}`,
    '',
    '  URLs that would be submitted:',
    ...plan.urls.map((url) => `    - ${url}`),
    '',
    '  Actor input (redacted):',
    ...JSON.stringify(plan.redactedActorInput, null, 2)
      .split('\n')
      .map((line) => `    ${line}`),
    '',
    '  Re-run with --execute (and APIFY_TOKEN set in this shell) to start a paid run.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function failMissing(what: string): never {
  throw new ScrapeError({
    code: 'output_error',
    message: `internal error: execute mode produced no ${what}`,
  });
}

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError('expected a positive integer');
  }
  return parsed;
}

function parsePositiveFloat(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('expected a positive number');
  }
  return parsed;
}

try {
  await program.parseAsync(process.argv);
} catch (error) {
  const scrapeError = ScrapeError.from(error);
  process.stderr.write(`\nerror [${scrapeError.code}]: ${scrapeError.message}\n\n`);
  process.exitCode = 1;
}
