import { ScrapeError } from '../../src/core/models/errors.js';

import { parseActorId, type ParsedActorId } from './actor-id.js';

export const DEFAULT_ACTOR_ID = 'clockworks/tiktok-scraper';

/** Safe default. Requirement, not a suggestion: this is real money. */
export const DEFAULT_MAX_CHARGE_USD = 0.25;

/**
 * The most a single benchmark run may ever be authorized to spend, whatever
 * the flags say. A cap is only a safety device if a typo cannot raise it — and
 * `--max-charge-usd 250` is one keystroke away from `2.50`.
 */
export const HARD_MAX_CHARGE_USD = 5;

export const DEFAULT_MAX_URLS = 5;

/** Hard ceiling on billable URLs per run, unreachable by any flag. */
export const HARD_MAX_URLS = 25;

export const DEFAULT_LOCAL_TIMEOUT_MS = 15_000;
export const DEFAULT_APIFY_TIMEOUT_MS = 120_000;

// The `waitForFinish` ceiling lives with the API client that enforces it, and
// is re-exported here so callers keep a single import for benchmark settings.
export { MAX_WAIT_FOR_FINISH_SECONDS } from './apify-client.js';

export interface RawOptions {
  readonly inputPath: string;
  readonly execute?: boolean | undefined;
  readonly actor?: string | undefined;
  readonly maxChargeUsd?: number | undefined;
  readonly maxUrls?: number | undefined;
  readonly localTimeoutMs?: number | undefined;
  readonly apifyTimeoutMs?: number | undefined;
  readonly outputDir?: string | undefined;
}

export interface BenchmarkOptions {
  readonly inputPath: string;
  /** `false` is dry run: validate, print, and make zero Apify requests. */
  readonly execute: boolean;
  readonly actor: ParsedActorId;
  readonly maxChargeUsd: number;
  readonly maxUrls: number;
  readonly localTimeoutMs: number;
  readonly apifyTimeoutMs: number;
  readonly outputDir: string;
  /**
   * Present only in execute mode. Held in memory, never written, never logged,
   * never placed in a URL — see `redactDeep`, which is applied to every
   * artifact before it reaches the filesystem.
   */
  readonly token: string | null;
}

export type EnvSource = Record<string, string | undefined>;

/**
 * Turns flags and environment into a validated, immediately-usable config.
 *
 * Every refusal happens here, before a single byte goes to Apify. The one rule
 * this module exists to enforce is that there is no path from a missing or
 * invalid setting to a paid run: a bad charge cap fails, it does not fall back
 * to a default, and a missing token in execute mode fails rather than quietly
 * degrading to a dry run.
 */
export function resolveOptions(raw: RawOptions, env: EnvSource = process.env): BenchmarkOptions {
  const execute = raw.execute === true;
  const actor = parseActorId(raw.actor ?? env.APIFY_ACTOR_ID ?? DEFAULT_ACTOR_ID);

  const maxChargeUsd = resolveChargeCap(raw.maxChargeUsd);
  const maxUrls = resolveUrlCap(raw.maxUrls);
  const localTimeoutMs = resolveTimeout(raw.localTimeoutMs, DEFAULT_LOCAL_TIMEOUT_MS, 'local');
  const apifyTimeoutMs = resolveTimeout(raw.apifyTimeoutMs, DEFAULT_APIFY_TIMEOUT_MS, 'apify');

  const token = (env.APIFY_TOKEN ?? '').trim();
  if (execute && token.length === 0) {
    throw new ScrapeError({
      code: 'config_error',
      message:
        'APIFY_TOKEN is not set, so --execute cannot start a paid run. ' +
        'Set it in the shell environment only (never on the command line or in a file), ' +
        'or drop --execute to dry run.',
    });
  }

  return {
    inputPath: raw.inputPath,
    execute,
    actor,
    maxChargeUsd,
    maxUrls,
    localTimeoutMs,
    apifyTimeoutMs,
    outputDir: raw.outputDir ?? './output/comparisons',
    // Deliberately not carried in dry-run mode: what is absent cannot leak.
    token: execute ? token : null,
  };
}

function resolveChargeCap(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_CHARGE_USD;
  if (!Number.isFinite(value) || value <= 0) {
    throw new ScrapeError({
      code: 'config_error',
      message: `invalid --max-charge-usd "${String(value)}": expected a positive number of dollars`,
    });
  }
  if (value > HARD_MAX_CHARGE_USD) {
    throw new ScrapeError({
      code: 'config_error',
      message:
        `--max-charge-usd ${value} exceeds the hard ceiling of $${HARD_MAX_CHARGE_USD} ` +
        'built into this benchmark; raise the ceiling in code if that is really intended',
    });
  }
  return value;
}

function resolveUrlCap(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_URLS;
  if (!Number.isInteger(value) || value < 1) {
    throw new ScrapeError({
      code: 'config_error',
      message: `invalid --max-urls "${String(value)}": expected a positive integer`,
    });
  }
  if (value > HARD_MAX_URLS) {
    throw new ScrapeError({
      code: 'config_error',
      message:
        `--max-urls ${value} exceeds the hard ceiling of ${HARD_MAX_URLS} URLs ` +
        'built into this benchmark',
    });
  }
  return value;
}

function resolveTimeout(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1_000) {
    throw new ScrapeError({
      code: 'config_error',
      message: `invalid --${label}-timeout-ms "${String(value)}": expected an integer >= 1000`,
    });
  }
  return value;
}
