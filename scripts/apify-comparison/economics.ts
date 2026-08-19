import { type ApifyRun } from './apify-client.js';
import { type ComparisonRow, type RunEconomics } from './types.js';

/** The volumes the decision will actually be made at. */
export const PROJECTION_VOLUMES = [1_000, 10_000, 100_000] as const;

export interface VolumeProjection {
  readonly videos: number;
  /** `null` whenever the per-video cost is unknown — never extrapolated from nothing. */
  readonly apifyCostUsd: number | null;
  readonly apifyBytes: number | null;
  readonly localBytes: number | null;
}

export interface EconomicsReport {
  readonly economics: RunEconomics;
  readonly successfulApifyResults: number;
  readonly successfulLocalResults: number;
  /** Actual spend divided by results that were actually usable. */
  readonly apifyCostPerSuccessUsd: number | null;
  readonly apifyBytesPerSuccess: number | null;
  readonly localBytesPerSuccess: number | null;
  readonly projections: readonly VolumeProjection[];
  /**
   * Anything the API did not tell us, named explicitly.
   *
   * A decision made on a cost figure that was quietly defaulted to zero is
   * worse than one made on an admitted gap, so every absence is listed rather
   * than filled in from the Actor's pricing page.
   */
  readonly unavailable: readonly string[];
}

export interface BuildEconomicsOptions {
  readonly run: ApifyRun | null;
  readonly rows: readonly ComparisonRow[];
  /** Total bytes the local scraper pulled, from the benchmark's own decorator. */
  readonly localResponseBytes: number | null;
}

/**
 * Assembles what the run actually cost, from what Apify actually reported.
 *
 * Nothing here is derived from marketing copy or from the Actor's advertised
 * price. If the API omitted a figure it stays `null` and is named in
 * `unavailable`; the report then says "unavailable" rather than printing a
 * confident number nobody measured.
 */
export function buildEconomics(options: BuildEconomicsOptions): EconomicsReport {
  const { run, rows } = options;
  const unavailable: string[] = [];

  const economics: RunEconomics = {
    usageTotalUsd: run?.usageTotalUsd ?? null,
    chargedEventCounts: run?.chargedEventCounts ?? null,
    pricingModel: run?.pricingModel ?? null,
    build: run?.buildNumber ?? null,
    runDurationMs: resolveDurationMs(run),
    netRxBytes: run?.netRxBytes ?? null,
    netTxBytes: run?.netTxBytes ?? null,
    localResponseBytes: options.localResponseBytes,
  };

  if (economics.usageTotalUsd === null) unavailable.push('usageTotalUsd');
  if (economics.chargedEventCounts === null) unavailable.push('chargedEventCounts');
  if (economics.pricingModel === null) unavailable.push('pricingModel');
  if (economics.build === null) unavailable.push('build');
  if (economics.netRxBytes === null) unavailable.push('stats.netRxBytes');
  if (economics.netTxBytes === null) unavailable.push('stats.netTxBytes');
  if (economics.runDurationMs === null) unavailable.push('runDuration');

  const successfulApifyResults = rows.filter((row) => row.apify.ok).length;
  const successfulLocalResults = rows.filter((row) => row.local.ok).length;

  const apifyCostPerSuccessUsd = perUnit(economics.usageTotalUsd, successfulApifyResults);
  const apifyBytesPerSuccess = perUnit(economics.netRxBytes, successfulApifyResults);
  const localBytesPerSuccess = perUnit(economics.localResponseBytes, successfulLocalResults);

  return {
    economics,
    successfulApifyResults,
    successfulLocalResults,
    apifyCostPerSuccessUsd,
    apifyBytesPerSuccess,
    localBytesPerSuccess,
    projections: PROJECTION_VOLUMES.map((videos) => ({
      videos,
      apifyCostUsd: scale(apifyCostPerSuccessUsd, videos),
      apifyBytes: scale(apifyBytesPerSuccess, videos),
      localBytes: scale(localBytesPerSuccess, videos),
    })),
    unavailable,
  };
}

function resolveDurationMs(run: ApifyRun | null): number | null {
  if (run === null) return null;
  if (run.runTimeSecs !== null) return Math.round(run.runTimeSecs * 1_000);
  if (run.startedAt === null || run.finishedAt === null) return null;
  const started = Date.parse(run.startedAt);
  const finished = Date.parse(run.finishedAt);
  if (Number.isNaN(started) || Number.isNaN(finished)) return null;
  return Math.max(0, finished - started);
}

/** `null` — not `0`, not `Infinity` — when either side of the division is unknown. */
function perUnit(total: number | null, count: number): number | null {
  if (total === null || count <= 0) return null;
  return total / count;
}

function scale(perUnitValue: number | null, videos: number): number | null {
  return perUnitValue === null ? null : perUnitValue * videos;
}
