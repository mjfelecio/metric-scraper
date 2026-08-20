import { nullLogger, type Logger } from '../../src/core/logging/logger.js';
import { ScrapeError } from '../../src/core/models/errors.js';
import { type MetricSnapshot } from '../../src/core/models/snapshot.js';
import { type Scraper } from '../../src/core/scraper/scraper.js';

import { type ActorAdapter, type NormalizedRow } from './actor-adapter.js';
import { ApifyClient, type ApifyRun, type ApifyTransport } from './apify-client.js';
import { buildApifyObservations, joinComparison } from './compare.js';
import { type CountingHttpClient } from './counting-http-client.js';
import { buildEconomics } from './economics.js';
import { collectLocally } from './local-collector.js';
import { type LoadedTargets } from './load-targets.js';
import { MAX_WAIT_FOR_FINISH_SECONDS, type BenchmarkOptions } from './options.js';
import { redactDeep } from './redact.js';
import { renderReport } from './report.js';
import { buildSummary, type BenchmarkSummary } from './summary.js';
import { EMPTY_METRICS, type ComparisonRow } from './types.js';

/** What a dry run reports instead of spending money. */
export interface DryRunPlan {
  readonly actorId: string;
  readonly actorPathId: string;
  readonly billableUrls: number;
  readonly maxUrls: number;
  readonly maxChargeUsd: number;
  readonly duplicatesCollapsed: number;
  readonly rejectedInputs: number;
  readonly urls: readonly string[];
  /** The Actor input exactly as it would be sent, with secrets scrubbed. */
  readonly redactedActorInput: unknown;
  readonly featureFlags: Record<string, unknown>;
}

export interface RunComparisonDeps {
  readonly options: BenchmarkOptions;
  readonly loaded: LoadedTargets;
  readonly adapter: ActorAdapter;
  readonly scraper: Scraper;
  readonly http: CountingHttpClient;
  /** Required in execute mode; must be absent-safe in dry run. */
  readonly transport?: ApifyTransport | undefined;
  readonly logger?: Logger | undefined;
  readonly now?: (() => Date) | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface ComparisonOutcome {
  readonly mode: 'dry-run' | 'execute';
  readonly plan: DryRunPlan;
  /** All `null`/empty for a dry run, which gathers nothing. */
  readonly rows: readonly ComparisonRow[];
  readonly localSnapshots: readonly MetricSnapshot[];
  readonly apifyDataset: unknown;
  readonly summary: BenchmarkSummary | null;
  readonly report: string | null;
  readonly apifyRun: ApifyRun | null;
  /** Set when the Apify side failed outright; the local side still ran. */
  readonly apifyError: string | null;
}

/**
 * Builds the plan a dry run prints and an execute run acts on.
 *
 * Separated so that the two modes cannot drift: what dry run shows you is,
 * by construction, the same object execute would send.
 */
export function buildPlan(deps: RunComparisonDeps): DryRunPlan {
  const { options, loaded, adapter } = deps;
  const actorInput = adapter.buildInput(loaded.targets);

  return {
    actorId: adapter.actorId,
    actorPathId: options.actor.pathId,
    billableUrls: loaded.targets.length,
    maxUrls: options.maxUrls,
    maxChargeUsd: options.maxChargeUsd,
    duplicatesCollapsed: loaded.duplicatesCollapsed,
    rejectedInputs: loaded.rejected.length,
    urls: loaded.targets.map((target) => target.url),
    redactedActorInput: redactDeep(actorInput, {
      secrets: options.token === null ? [] : [options.token],
    }),
    featureFlags: adapter.describeFeatureFlags(actorInput),
  };
}

/**
 * Runs the experiment.
 *
 * Dry run is the default and is **entirely offline**: it builds the plan and
 * returns. It contacts neither Apify nor TikTok, which makes "did this cost
 * anything" a question with a structural answer rather than a hopeful one.
 *
 * Execute mode starts the Actor first and scrapes locally while it runs, so
 * the two observations are as close together in time as the slower source
 * allows. Each side keeps its own timestamp and latency; a failure on either
 * side is recorded as that source's failure and never filled in from the other.
 */
export async function runComparison(deps: RunComparisonDeps): Promise<ComparisonOutcome> {
  const plan = buildPlan(deps);
  const { options, loaded, adapter } = deps;
  const now = deps.now ?? ((): Date => new Date());

  if (!options.execute) {
    return {
      mode: 'dry-run',
      plan,
      rows: [],
      localSnapshots: [],
      apifyDataset: null,
      summary: null,
      report: null,
      apifyRun: null,
      apifyError: null,
    };
  }

  if (deps.transport === undefined || options.token === null) {
    // Unreachable through the CLI, which validates first. Kept because the
    // one thing this module must never do is start a paid run half-configured.
    throw new ScrapeError({
      code: 'config_error',
      message: 'execute mode requires both an Apify transport and a token',
    });
  }

  const client = new ApifyClient({
    transport: deps.transport,
    token: options.token,
    deadlineMs: options.apifyTimeoutMs,
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
  });

  const timeoutSecs = Math.max(1, Math.ceil(options.apifyTimeoutMs / 1_000));
  const apifyStartedMs = Date.now();
  const apifyObservedAt = now().toISOString();

  // Settled rather than awaited, so the local scrape overlaps the Actor run and
  // an Apify failure cannot surface as an unhandled rejection mid-scrape.
  const apifySettled = (async (): Promise<ApifyRun> => {
    const started = await client.startRun({
      actorPathId: options.actor.pathId,
      input: adapter.buildInput(loaded.targets),
      maxTotalChargeUsd: options.maxChargeUsd,
      maxItems: loaded.targets.length,
      timeoutSecs,
      waitForFinishSecs: Math.min(MAX_WAIT_FOR_FINISH_SECONDS, timeoutSecs),
    });
    return client.waitForRun(started);
  })().then(
    (value) => ({ ok: true, value }) as const,
    (error: unknown) => ({ ok: false, error }) as const,
  );

  const local = await collectLocally(loaded.targets, {
    scraper: deps.scraper,
    http: deps.http,
    timeoutMs: options.localTimeoutMs,
    logger: deps.logger ?? nullLogger,
    now,
  });

  const settled = await apifySettled;

  let apifyRun: ApifyRun | null = null;
  let apifyError: string | null = null;
  let dataset: unknown[] = [];

  if (settled.ok) {
    apifyRun = settled.value;
    try {
      dataset = await client.getDatasetItems(apifyRun.id);
    } catch (error) {
      apifyError = describe(error);
    }
    apifyRun = await settleBilling(client, apifyRun, deps.sleep, deps.logger);
  } else {
    apifyError = describe(settled.error);
  }

  const apifyLatencyMs = Date.now() - apifyStartedMs;
  const normalized: NormalizedRow[] =
    apifyError === null ? dataset.map((row) => adapter.normalizeRow(row)) : [];

  const apifyObservations =
    apifyError === null
      ? buildApifyObservations({
          targets: loaded.targets,
          rows: normalized,
          observedAt: apifyObservedAt,
          latencyMs: apifyLatencyMs,
          // Apify reports bandwidth for the run as a whole; splitting it across
          // rows would invent a per-video figure it never measured.
          bytesPerRow: null,
        })
      : loaded.targets.map((target) => ({
          videoId: target.videoId,
          ok: false,
          metrics: EMPTY_METRICS,
          observedAt: apifyObservedAt,
          latencyMs: apifyLatencyMs,
          error: apifyError,
          responseBytes: null,
        }));

  const rows = joinComparison(loaded.targets, local.observations, apifyObservations);

  const economics = buildEconomics({
    run: apifyRun,
    rows,
    localResponseBytes: local.totalBytes,
  });

  const summary = buildSummary({
    generatedAt: now().toISOString(),
    mode: 'execute',
    actorId: adapter.actorId,
    actorPathId: options.actor.pathId,
    runId: apifyRun?.id ?? null,
    terminalStatus: apifyRun?.status ?? null,
    build: apifyRun?.buildNumber ?? null,
    datasetId: apifyRun?.defaultDatasetId ?? null,
    featureFlags: plan.featureFlags,
    caps: {
      maxChargeUsd: options.maxChargeUsd,
      maxUrls: options.maxUrls,
      localTimeoutMs: options.localTimeoutMs,
      apifyTimeoutMs: options.apifyTimeoutMs,
    },
    input: {
      path: options.inputPath,
      candidates: loaded.totalCandidates,
      accepted: loaded.targets.length + loaded.duplicatesCollapsed,
      rejected: loaded.rejected.length,
      duplicatesCollapsed: loaded.duplicatesCollapsed,
      billableUrls: loaded.targets.length,
    },
    rows,
    apifyLatencyMs,
    economics,
  });

  return {
    mode: 'execute',
    plan,
    rows,
    localSnapshots: local.snapshots,
    apifyDataset: dataset,
    summary,
    report: renderReport(summary, rows),
    apifyRun,
    apifyError,
  };
}

function describe(error: unknown): string {
  const scrapeError = ScrapeError.from(error);
  return `${scrapeError.code}: ${scrapeError.message}`;
}

/**
 * Re-reads the run once the dataset is in hand, to pick up settled charges.
 *
 * Apify posts a run's cost *after* it reports `SUCCEEDED`. Reading
 * `usageTotalUsd` at the moment the status flips therefore yields `0` with
 * every `chargedEventCounts` entry at zero — which the report would then
 * publish as "Actual run cost: $0.0000" and, worse, project forward as a $0
 * cost at 100,000 videos. Two real runs measured $0.0134 and $0.0158 a few
 * seconds after each reported $0.
 *
 * A billing re-read is not worth failing the benchmark over: the metrics are
 * already collected, so any error here is swallowed and the original run kept.
 */
async function settleBilling(
  client: ApifyClient,
  run: ApifyRun,
  sleep: ((ms: number) => Promise<void>) | undefined,
  logger: Logger | undefined,
): Promise<ApifyRun> {
  if (hasBilling(run)) return run;
  const wait = sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (const delayMs of BILLING_SETTLE_DELAYS_MS) {
    try {
      await wait(delayMs);
      const refreshed = await client.getRun(run.id);
      if (hasBilling(refreshed)) return refreshed;
    } catch (error) {
      logger?.warn({ err: describe(error) }, 'could not re-read the run for settled charges');
      return run;
    }
  }
  return run;
}

/** Delays between billing re-reads. Bounded: cost detail is not worth a long stall. */
const BILLING_SETTLE_DELAYS_MS = [2_000, 4_000] as const;

/** True once Apify has posted a non-zero cost or a non-zero charged event. */
function hasBilling(run: ApifyRun): boolean {
  if (run.usageTotalUsd !== null && run.usageTotalUsd > 0) return true;
  return Object.values(run.chargedEventCounts ?? {}).some((value) => value > 0);
}
