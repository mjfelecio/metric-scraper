import { assumption, config, measured, unset, type Provenance } from './provenance.js';

/**
 * Every configurable assumption in the capacity model, in one place.
 *
 * The rule this file exists to enforce: nothing production-sensitive is a
 * literal buried in a formula. If a number would change the answer, it is a
 * field here, it has a default, and that default has a {@link Provenance}
 * saying whether anyone actually measured it.
 */

export const PLATFORM_KEYS = ['tiktok', 'instagram', 'custom'] as const;
export type PlatformKey = (typeof PLATFORM_KEYS)[number];

/**
 * One phase of a submission's polling life.
 *
 * `enabled` and `intervalMs` are deliberately independent, because the two
 * ways of "turning a stage off" mean different things:
 *
 * | intent                    | encoding                        | consumes lifecycle days |
 * | ------------------------- | ------------------------------- | ----------------------- |
 * | this phase does not exist | `enabled: false`                | no — collapses          |
 * | keep it, but stop polling | `enabled: true, intervalMs: null` | yes                   |
 *
 * The default lifecycle needs the second: the trailing nine days are what make
 * the lifecycle thirty days rather than twenty-one, and dropping them would
 * change when submissions age out of the active set. Collapsing them into a
 * single flag would make one of the two behaviours unreachable.
 *
 * `intervalMs: 0` is rejected by validation rather than treated as "off" — `0`
 * is what an emptied numeric input produces, and `86_400_000 / 0` is `Infinity`.
 */
export interface PollingStage {
  readonly id: string;
  readonly label: string;
  /** Whole days. */
  readonly durationDays: number;
  /** Start-to-start gap between polls. `null` = in lifecycle, never polled. */
  readonly intervalMs: number | null;
  readonly enabled: boolean;
}

export interface RetryBackoff {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly backoffFactor: number;
  readonly jitter: boolean;
}

/**
 * The reliability model's three free parameters.
 *
 * The brief asks for five knobs — success rate, error rate, retry rate, average
 * retries per failed job, maximum retries — but at most three of those are
 * independent, and naively driving the model from a *job* success rate gets the
 * retry volume badly wrong. In the reference run
 * (`output/tiktok-2026-08-21T15-27-22-305Z.session.json`) 81 of 1,600 jobs
 * failed and every one of them was `private` or `parse_error` — statuses
 * `isPermanentStatus` never retries. Fitting a per-attempt failure rate to the
 * 94.94% job success rate as if those were retryable predicts a 28.7% retry
 * rate against a measured 0.99%: a thirty-fold error.
 *
 * So the free inputs separate the two populations, and everything the brief
 * lists is derived from them and displayed — see `reliability.ts`.
 */
export interface ReliabilityInputs {
  /** Probability one attempt succeeds, among jobs that *can* be retried. */
  readonly perAttemptSuccessRate: number;
  /** Share of all jobs whose failure is permanent — never retried. */
  readonly nonRetryableShare: number;
  /** Total attempts including the first. `RETRY_MAX_ATTEMPTS`. */
  readonly maxAttempts: number;
  readonly retryBackoff: RetryBackoff;
}

/**
 * Per-proxy limits. `null` means "no limit, or nobody has told us" — never `0`.
 *
 * `.env` uses `0` for "unlimited" (`PROXY_MAX_CONCURRENT`), which is the
 * opposite convention. Anything bridging from env must map `0` to `null`
 * through {@link envZeroToNull}; inside the model `0` would size a pool to
 * infinity, and `0` is exactly what a cleared numeric input yields.
 */
export interface ProxyLimits {
  readonly maxConcurrentPerProxy: number | null;
  readonly maxRequestsPerMinutePerProxy: number | null;
  readonly maxBytesPerMonthPerProxy: number | null;
  /** The floor every proxy starts at — `PROXY_PROBATION_CONCURRENT`. */
  readonly probationConcurrency: number;
  /**
   * Mean capacity a proxy has actually *earned* on a warm pool.
   *
   * `in-memory-proxy-pool.ts` grants capacity by doubling on success and
   * halving on failure, so `proxies x PROXY_MAX_CONCURRENT` is a ceiling the
   * pool reaches only if nothing ever fails. `null` when unknown.
   */
  readonly earnedConcurrencyPerProxy: number | null;
}

export interface CapacityConfig {
  /** Job admission target — `SCRAPER_TARGET_RPM`. Jobs, never HTTP requests. */
  readonly targetJobsPerMinute: number;
  readonly peakMultiplier: number;
  /** Absolute peak, overriding the multiplier when set. */
  readonly peakJobsPerMinuteOverride: number | null;
  /** Process count. Every limit in this codebase is process-local (README §12). */
  readonly workers: number;
  readonly concurrencyPerWorker: number;
  /** Per-platform egress ceiling, in HTTP requests/min. `null` = none. */
  readonly httpRpmPerHost: number | null;
  readonly proxyPoolSize: number;
  readonly proxyLimits: ProxyLimits;
  /** Fraction added to demand before sizing, e.g. `0.2` for 20%. */
  readonly safetyMargin: number;
}

/**
 * Proxy pricing. Every field is nullable; all-null means nothing is computed.
 *
 * Both shapes the brief asks for are supported at once rather than as a union,
 * because a real invoice is often both — a per-GB rate on top of a monthly
 * commitment — and because a union forces the UI to discard whichever field the
 * operator is not currently using.
 */
export interface Pricing {
  readonly pricePerGb: number | null;
  /** Vendors differ; the two bases are 7.4% apart, so it has to be stated. */
  readonly billingUnit: 'GB' | 'GiB';
  /** When false, only successful attempts are billed. */
  readonly billsFailedAttempts: boolean;
  readonly fixedMonthlyPerProxy: number | null;
  readonly fixedMonthlyPool: number | null;
}

export interface GrowthInputs {
  readonly enabled: boolean;
  /** Compounding monthly growth in submissions, e.g. `0.1` for 10%. */
  readonly monthlyGrowthRate: number;
  readonly months: number;
}

export interface CapacityInputs {
  readonly platform: PlatformKey;
  readonly newSubmissionsPerDay: number;
  readonly horizonDays: number;
  readonly stages: readonly PollingStage[];

  /** Outbound HTTP requests one scrape job makes on its success path. */
  readonly requestsPerJob: number | null;
  readonly bytesPerHttpRequest: number | null;
  /**
   * Mean *service time* of one job — excluding time queued on our own egress
   * limiter.
   *
   * `concurrency-diagnostics.ts:130-137` explains why the distinction is
   * load-bearing: sizing against a latency that already contains our own
   * queueing "would let a badly oversubscribed run inflate its own latency and
   * thereby justify the concurrency causing the problem".
   */
  readonly meanJobLatencyMs: number | null;
  readonly p95JobLatencyMs: number | null;
  /** Mean service time of one outbound HTTP request. */
  readonly meanHttpLatencyMs: number | null;
  readonly p95HttpLatencyMs: number | null;

  readonly reliability: ReliabilityInputs;
  readonly capacity: CapacityConfig;
  readonly pricing: Pricing;
  readonly growth: GrowthInputs;
}

/** Bridges `.env`'s `0 = unlimited` convention into this model's `null`. */
export function envZeroToNull(value: number): number | null {
  return value === 0 ? null : value;
}

export const MS_PER_DAY = 86_400_000;
export const MINUTES_PER_DAY = 1_440;
/** The month used for every "per month" rollup. Stated so it is never guessed. */
export const DAYS_PER_MONTH = 30;

const REFERENCE_RUN = 'output/tiktok-2026-08-21T15-27-22-305Z.session.json';

/**
 * The lifecycle in the operating policy:
 * - Days 1–7: poll every fifteen minutes.
 * - Days 8–29: poll every twelve hours.
 * - Day 30: polling stops entirely.
 */
export const TAPERED_STAGES: readonly PollingStage[] = [
  { id: 'stage-1', label: 'Fresh', durationDays: 7, intervalMs: 900_000, enabled: true },
  { id: 'stage-2', label: 'Settling', durationDays: 22, intervalMs: 43_200_000, enabled: true },
  { id: 'stage-3', label: 'Dormant', durationDays: 1, intervalMs: null, enabled: true },
];

/**
 * The flat approximation the stress harness assumes.
 *
 * `src/stress/load-generator/profiles.ts:37-48` sizes its sustained profile as
 * "every 15 minutes for up to 30 days", which is this. Kept as a preset so the
 * two models can be compared directly — the gap between them is most of the
 * reason this calculator exists.
 */
export const FLAT_STAGES: readonly PollingStage[] = [
  { id: 'stage-1', label: 'Flat 15m', durationDays: 30, intervalMs: 900_000, enabled: true },
];

export const DEFAULT_RETRY_BACKOFF: RetryBackoff = {
  initialDelayMs: 250,
  maxDelayMs: 10_000,
  backoffFactor: 2,
  jitter: true,
};

export const DEFAULT_CAPACITY_INPUTS: CapacityInputs = {
  platform: 'tiktok',
  newSubmissionsPerDay: 500,
  horizonDays: 30,
  stages: TAPERED_STAGES,

  requestsPerJob: 2,
  bytesPerHttpRequest: 25_500,
  meanJobLatencyMs: 7_330,
  p95JobLatencyMs: 8_442,
  meanHttpLatencyMs: null,
  p95HttpLatencyMs: null,

  reliability: {
    perAttemptSuccessRate: 0.9901,
    nonRetryableShare: 0.050625,
    maxAttempts: 3,
    retryBackoff: DEFAULT_RETRY_BACKOFF,
  },

  capacity: {
    targetJobsPerMinute: 500,
    peakMultiplier: 2,
    peakJobsPerMinuteOverride: null,
    workers: 1,
    concurrencyPerWorker: 10,
    httpRpmPerHost: 300,
    proxyPoolSize: 20,
    proxyLimits: {
      maxConcurrentPerProxy: 8,
      maxRequestsPerMinutePerProxy: null,
      maxBytesPerMonthPerProxy: null,
      probationConcurrency: 1,
      earnedConcurrencyPerProxy: 7.6,
    },
    safetyMargin: 0.2,
  },

  pricing: {
    pricePerGb: null,
    billingUnit: 'GB',
    billsFailedAttempts: true,
    fixedMonthlyPerProxy: null,
    fixedMonthlyPool: null,
  },

  growth: { enabled: false, monthlyGrowthRate: 0.1, months: 12 },
};

/** Instagram differs enough in fan-out and payload size to be its own preset. */
export const INSTAGRAM_OVERRIDES = {
  platform: 'instagram' as const,
  requestsPerJob: 2.6,
  bytesPerHttpRequest: 28_000,
  httpRpmPerHost: 180,
};

export interface CapacityPreset {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly inputs: CapacityInputs;
}

export const CAPACITY_PRESETS: readonly CapacityPreset[] = [
  {
    id: 'tiktok',
    label: 'TikTok',
    description: 'Measured TikTok fan-out and payload, tapered 30-day lifecycle.',
    inputs: DEFAULT_CAPACITY_INPUTS,
  },
  {
    id: 'instagram',
    label: 'Instagram',
    description: 'Measured Instagram fan-out and payload, same lifecycle.',
    inputs: {
      ...DEFAULT_CAPACITY_INPUTS,
      platform: 'instagram',
      requestsPerJob: INSTAGRAM_OVERRIDES.requestsPerJob,
      bytesPerHttpRequest: INSTAGRAM_OVERRIDES.bytesPerHttpRequest,
      capacity: {
        ...DEFAULT_CAPACITY_INPUTS.capacity,
        httpRpmPerHost: INSTAGRAM_OVERRIDES.httpRpmPerHost,
      },
    },
  },
  {
    id: 'flat',
    label: 'Flat 15m (stress-harness model)',
    description:
      'The approximation in profiles.ts — every submission polled every 15 minutes for the full 30 days.',
    inputs: { ...DEFAULT_CAPACITY_INPUTS, stages: FLAT_STAGES },
  },
];

/**
 * Where each default came from, keyed by the dotted path of the field.
 *
 * Rendered beside the input, so an operator can tell at a glance which numbers
 * are observations and which are somebody's guess.
 */
export const CAPACITY_PROVENANCE: Readonly<Record<string, Provenance>> = {
  newSubmissionsPerDay: assumption(
    'src/stress/load-generator/profiles.ts:37-48',
    'the brief’s "300-500 new submissions/day"',
  ),
  horizonDays: assumption('', 'one full lifecycle'),
  stages: assumption('', 'operating policy; only the 15m interval appears in code'),
  requestsPerJob: measured(
    'src/platforms/tiktok/tiktok-scraper.ts:45,126',
    'two request sites; run summaries 2.00-2.12',
  ),
  bytesPerHttpRequest: measured(
    'output/bandwidth-baselines-tiktok.jsonl',
    'rounded planning preset; measured average 25,551.84 bytes/request across 10 runs and 400 requests',
  ),
  meanJobLatencyMs: measured(REFERENCE_RUN, '7,330 ms observed mean job latency'),
  p95JobLatencyMs: measured(REFERENCE_RUN, '8,442 ms observed p95 job latency'),
  meanHttpLatencyMs: unset('HTTP latency was not measured independently of whole-job latency'),
  p95HttpLatencyMs: unset('HTTP latency was not measured independently of whole-job latency'),
  'reliability.perAttemptSuccessRate': measured(
    REFERENCE_RUN,
    '15 retries across 1,519 retry-eligible jobs',
  ),
  'reliability.nonRetryableShare': measured(
    REFERENCE_RUN,
    '44 private + 37 parse_error of 1,600 jobs',
  ),
  'reliability.maxAttempts': config('RETRY_MAX_ATTEMPTS'),
  'capacity.targetJobsPerMinute': config('SCRAPER_TARGET_RPM'),
  'capacity.concurrencyPerWorker': config('SCRAPER_CONCURRENCY'),
  'capacity.workers': assumption('', 'single process today; README §12'),
  'capacity.httpRpmPerHost': config('TIKTOK_HTTP_RPM_PER_HOST'),
  'capacity.proxyPoolSize': measured(REFERENCE_RUN, 'proxies.configured'),
  'capacity.proxyLimits.maxConcurrentPerProxy': config('PROXY_MAX_CONCURRENT'),
  'capacity.proxyLimits.probationConcurrency': config('PROXY_PROBATION_CONCURRENT'),
  'capacity.proxyLimits.earnedConcurrencyPerProxy': measured(
    REFERENCE_RUN,
    'proxies.capacity 152 over 20 configured',
  ),
  'capacity.proxyLimits.maxRequestsPerMinutePerProxy': unset('no vendor limit recorded'),
  'capacity.proxyLimits.maxBytesPerMonthPerProxy': unset('no vendor limit recorded'),
  'capacity.peakMultiplier': assumption('', 'not measured'),
  'capacity.safetyMargin': assumption('', 'operational convention'),
  'pricing.pricePerGb': unset('no proxy vendor selected'),
  'pricing.fixedMonthlyPerProxy': unset('no proxy vendor selected'),
  'pricing.fixedMonthlyPool': unset('no proxy vendor selected'),
  'growth.monthlyGrowthRate': assumption('', 'not measured'),
};

/** Applies the platform-specific artifact labels without changing any formula. */
export function capacityProvenanceFor(platform: PlatformKey): Readonly<Record<string, Provenance>> {
  if (platform === 'custom') {
    return {
      ...CAPACITY_PROVENANCE,
      requestsPerJob: unset('custom HTTP fan-out is not established'),
      bytesPerHttpRequest: unset('custom payload size is not established'),
      meanJobLatencyMs: unset('custom job latency is not established'),
      p95JobLatencyMs: unset('custom job latency is not established'),
      meanHttpLatencyMs: unset('custom HTTP latency is not established'),
      p95HttpLatencyMs: unset('custom HTTP latency is not established'),
    };
  }
  if (platform === 'instagram') {
    return {
      ...CAPACITY_PROVENANCE,
      requestsPerJob: measured(
        'src/platforms/instagram/instagram-scraper.ts',
        'measured average fan-out preset',
      ),
      bytesPerHttpRequest: measured(
        'output/bandwidth-baselines-instagram.jsonl',
        'rounded planning preset; measured average 27,517 bytes/request',
      ),
      'capacity.httpRpmPerHost': config('INSTAGRAM_HTTP_RPM_PER_HOST'),
    };
  }
  return CAPACITY_PROVENANCE;
}
