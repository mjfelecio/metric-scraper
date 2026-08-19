import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

import { ScrapeError } from '../core/models/errors.js';

const LogLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']);

export const AppConfigSchema = z.object({
  logLevel: LogLevelSchema,

  concurrency: z.number().int().min(1).max(1_000),
  /**
   * Logical scrape jobs admitted per minute — one URL is one unit however many
   * HTTP calls or retries it costs. `0` disables pacing entirely.
   */
  targetRpm: z.number().int().min(0),
  /** Jobs admissible at once after idle. `0` = one second's worth of `targetRpm`. */
  burst: z.number().int().min(0),
  /**
   * Ceiling on actual outbound HTTP requests per minute, per host — retries and
   * multi-hop platform calls included. This is what protects upstream; `targetRpm`
   * does not, because one job can be many requests. `0` disables.
   */
  httpRpmPerHost: z.number().int().min(0),
  /** `0` means an unbounded queue. Producers wait for room rather than failing. */
  maxQueueSize: z.number().int().min(0),
  /**
   * Default gap between cycle starts in a continuous session. Content Rewards
   * polls every 15 minutes; overridable so tests can exercise the same code
   * path in seconds. `0` means back-to-back cycles.
   */
  pollIntervalMs: z.number().int().min(0),
  requestTimeoutMs: z.number().int().min(1),

  retry: z.object({
    maxAttempts: z.number().int().min(1).max(20),
    initialDelayMs: z.number().int().min(0),
    maxDelayMs: z.number().int().min(0),
    backoffFactor: z.number().min(1),
    jitter: z.boolean(),
  }),

  outputDir: z.string().min(1),

  proxy: z.object({
    /** Raw `PROXY_POOL` value; parsed by `parseProxyList`. Never logged. */
    pool: z.string(),
    maxConsecutiveFailures: z.number().int().min(1),
    cooldownMs: z.number().int().min(0),
    /**
     * The most jobs any one proxy may hold at a time. `0` = unlimited.
     *
     * A ceiling rather than an allocation: a proxy doubles its slots with each
     * success up to this, and halves them with each failure. `proxies × limit`
     * is the pool's maximum capacity; what has actually been earned is reported
     * as `proxies.capacity` in the run summary, and that is the number to
     * compare a configured concurrency against.
     */
    maxConcurrentPerProxy: z.number().int().min(0),
    /**
     * The floor every proxy starts at and can be pushed back down to.
     *
     * Health is only evaluated when a lease is handed out, so this is what
     * bounds how many jobs a dead IP can absorb before its first failure is
     * reported back. A proxy that has never succeeded never leaves it.
     */
    probationConcurrency: z.number().int().min(1),
    /**
     * One lease in this many is reserved for a proxy that has never succeeded.
     * `0` disables exploration.
     *
     * Without a reserved share, a proxy needs a success to be preferred but is
     * scheduled last, so it never gets the traffic that would earn one — and a
     * large pool behaves like whichever two proxies happened to work first.
     */
    explorationPeriod: z.number().int().min(0),
    /**
     * Undici's own connect-phase timeout for each proxy's dispatcher. Without
     * this, undici defaults to 10s before giving up on a dead proxy — well past
     * what a dead exit node needs to be declared unreachable, and it fires
     * before `requestTimeoutMs` ever gets a chance to.
     */
    connectTimeoutMs: z.number().int().min(1),
    /**
     * How long a job waits for a proxy before the attempt fails.
     *
     * Only ever spent when waiting could help: a cooldown due to expire, or a
     * source with candidates left to admit. `0` fails at once. Without it a
     * burst of evictions failed every in-flight job rather than costing them a
     * few seconds of latency.
     */
    acquireWaitMs: z.number().int().min(0),

    /**
     * A live supply of candidate proxies, on top of (never instead of) `pool`.
     *
     * An empty `url` disables the whole feature, matching how `PROXY_POOL` and
     * `SESSION_STORE_PATH` are switched off. Candidates are validated and fed
     * into the same pool the static list uses; nothing here decides health.
     */
    source: z.object({
      url: z.string(),
      refreshIntervalMs: z.number().int().min(0),
      /**
       * Usable capacity to aim for, in concurrent slots. `0` derives it from
       * the run's effective concurrency, which is the only way the two cannot
       * silently disagree.
       */
      targetCapacity: z.number().int().min(0),
      /** Startup waits for this much capacity, not for `targetCapacity`. */
      minCapacity: z.number().int().min(1),
      validateConcurrency: z.number().int().min(1),
      validateTimeoutMs: z.number().int().min(1),
      maxCandidates: z.number().int().min(1),
    }),
  }),

  session: z.object({
    /** Path to an operator-supplied session file, or `null` to run anonymously. */
    storePath: z.string().min(1).nullable(),
    maxConsecutiveFailures: z.number().int().min(1),
    cooldownMs: z.number().int().min(0),
  }),

  instagram: z.object({
    postDocId: z.string().regex(/^\d+$/),
    clipsDocId: z.string().regex(/^\d+$/),
    clipsMaxPages: z.number().int().min(1).max(10),
    clipsMaxAuthors: z.number().int().min(1).max(10),
  }),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

export type EnvSource = Record<string, string | undefined>;

export interface LoadConfigOptions {
  env?: EnvSource | undefined;
  /** Set to false to skip reading a `.env` file (tests). */
  dotenv?: boolean | undefined;
}

/**
 * Builds the application configuration from the environment.
 *
 * Every value has a working default, so a fresh clone runs with no `.env` at
 * all. Values are parsed leniently (empty string = unset) and then validated
 * strictly by Zod, so a typo fails at startup with a readable message instead
 * of surfacing as strange behaviour mid-run.
 */
export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  if (options.dotenv !== false) {
    loadDotenv({ quiet: true });
  }
  const env = options.env ?? process.env;
  rejectRetiredKeys(env);

  const candidate = {
    logLevel: str(env.LOG_LEVEL) ?? 'info',

    concurrency: int(env, 'SCRAPER_CONCURRENCY', 10),
    targetRpm: int(env, 'SCRAPER_TARGET_RPM', 500),
    burst: int(env, 'SCRAPER_BURST', 0),
    httpRpmPerHost: int(env, 'SCRAPER_HTTP_RPM_PER_HOST', 0),
    // Bounded by default: an unbounded queue turns a large input straight into
    // unbounded pending work, and the producer has no way to feel the pressure.
    maxQueueSize: int(env, 'SCRAPER_MAX_QUEUE_SIZE', 1_000),
    pollIntervalMs: int(env, 'SCRAPER_POLL_INTERVAL_MS', 900_000),
    requestTimeoutMs: int(env, 'SCRAPER_REQUEST_TIMEOUT_MS', 15_000),

    retry: {
      maxAttempts: int(env, 'RETRY_MAX_ATTEMPTS', 3),
      initialDelayMs: int(env, 'RETRY_INITIAL_DELAY_MS', 250),
      maxDelayMs: int(env, 'RETRY_MAX_DELAY_MS', 10_000),
      backoffFactor: num(env, 'RETRY_BACKOFF_FACTOR', 2),
      jitter: bool(env, 'RETRY_JITTER', true),
    },

    outputDir: str(env.OUTPUT_DIR) ?? './output',

    proxy: {
      pool: str(env.PROXY_POOL) ?? '',
      maxConsecutiveFailures: int(env, 'PROXY_MAX_FAILURES', 3),
      cooldownMs: int(env, 'PROXY_COOLDOWN_MS', 60_000),
      maxConcurrentPerProxy: int(env, 'PROXY_MAX_CONCURRENT', 8),
      probationConcurrency: int(env, 'PROXY_PROBATION_CONCURRENT', 1),
      explorationPeriod: int(env, 'PROXY_EXPLORATION_PERIOD', 5),
      connectTimeoutMs: int(env, 'PROXY_CONNECT_TIMEOUT_MS', 3_000),
      acquireWaitMs: int(env, 'PROXY_ACQUIRE_WAIT_MS', 5_000),
      source: {
        url: str(env.PROXY_SOURCE_URL) ?? '',
        refreshIntervalMs: int(env, 'PROXY_SOURCE_REFRESH_MS', 900_000),
        targetCapacity: int(env, 'PROXY_SOURCE_TARGET_CAPACITY', 0),
        minCapacity: int(env, 'PROXY_SOURCE_MIN_CAPACITY', 5),
        validateConcurrency: int(env, 'PROXY_SOURCE_VALIDATE_CONCURRENCY', 10),
        validateTimeoutMs: int(env, 'PROXY_SOURCE_VALIDATE_TIMEOUT_MS', 5_000),
        maxCandidates: int(env, 'PROXY_SOURCE_MAX_CANDIDATES', 5_000),
      },
    },

    session: {
      storePath: str(env.SESSION_STORE_PATH) ?? null,
      maxConsecutiveFailures: int(env, 'SESSION_MAX_FAILURES', 3),
      cooldownMs: int(env, 'SESSION_COOLDOWN_MS', 300_000),
    },

    instagram: {
      postDocId: str(env.INSTAGRAM_POST_DOC_ID) ?? '27128499623469141',
      clipsDocId: str(env.INSTAGRAM_CLIPS_DOC_ID) ?? '27234427476213202',
      clipsMaxPages: int(env, 'INSTAGRAM_CLIPS_MAX_PAGES', 2),
      clipsMaxAuthors: int(env, 'INSTAGRAM_CLIPS_MAX_AUTHORS', 3),
    },
  };

  const parsed = AppConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new ScrapeError({ code: 'config_error', message: `invalid configuration — ${detail}` });
  }

  if (parsed.data.retry.maxDelayMs < parsed.data.retry.initialDelayMs) {
    throw new ScrapeError({
      code: 'config_error',
      message: 'invalid configuration — RETRY_MAX_DELAY_MS must be >= RETRY_INITIAL_DELAY_MS',
    });
  }

  if (parsed.data.proxy.connectTimeoutMs >= parsed.data.requestTimeoutMs) {
    throw new ScrapeError({
      code: 'config_error',
      message:
        'invalid configuration — PROXY_CONNECT_TIMEOUT_MS must be less than SCRAPER_REQUEST_TIMEOUT_MS',
    });
  }

  return parsed.data;
}

/**
 * The capacity the proxy supply should aim at, in concurrent slots.
 *
 * Unset (`0`) means "however much the run is actually going to use", which is
 * the only setting under which the target and the concurrency cannot drift
 * apart — they were separately configured before, and a 5× disagreement between
 * them went unnoticed for as long as it existed.
 */
export function resolveTargetCapacity(config: AppConfig, concurrency: number): number {
  const configured = config.proxy.source.targetCapacity;
  return configured > 0 ? configured : Math.max(1, concurrency);
}

/**
 * Settings that were removed because their unit changed, and what replaced them.
 *
 * These were denominated in proxies; their replacements are denominated in
 * concurrent slots, which for a pool with an eight-slot ceiling is a number
 * meaning something up to eight times larger. Silently reading the old value
 * under the new meaning is exactly the kind of unit error this pair of settings
 * caused in the first place, so a stale `.env` fails loudly instead.
 */
const RETIRED_KEYS: Record<string, string> = {
  PROXY_SOURCE_DESIRED_ACTIVE: 'PROXY_SOURCE_TARGET_CAPACITY',
  PROXY_SOURCE_MIN_HEALTHY: 'PROXY_SOURCE_MIN_CAPACITY',
};

function rejectRetiredKeys(env: EnvSource): void {
  for (const [retired, replacement] of Object.entries(RETIRED_KEYS)) {
    if (str(env[retired]) === undefined) continue;
    throw new ScrapeError({
      code: 'config_error',
      message:
        `invalid configuration — ${retired} has been replaced by ${replacement}, ` +
        'which is denominated in concurrent slots rather than in proxies; ' +
        'set the new name to the capacity you want (or leave it unset to follow SCRAPER_CONCURRENCY)',
    });
  }
}

/** Config with secrets removed, safe to log or return from the web API. */
export function redactConfig(config: AppConfig): Record<string, unknown> {
  const proxyCount = config.proxy.pool
    .split(/[\n,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0).length;

  return {
    logLevel: config.logLevel,
    concurrency: config.concurrency,
    targetRpm: config.targetRpm,
    burst: config.burst,
    httpRpmPerHost: config.httpRpmPerHost,
    maxQueueSize: config.maxQueueSize,
    pollIntervalMs: config.pollIntervalMs,
    requestTimeoutMs: config.requestTimeoutMs,
    retry: config.retry,
    outputDir: config.outputDir,
    proxy: {
      configured: proxyCount,
      // The URL itself stays out: it is operator-supplied and may one day carry
      // an API key, and nothing downstream needs to read it back.
      source:
        config.proxy.source.url === ''
          ? null
          : { target_capacity: resolveTargetCapacity(config, config.concurrency) },
    },
    session: { configured: config.session.storePath !== null },
    instagram: { ...config.instagram },
  };
}

function str(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function num(env: EnvSource, key: string, fallback: number): number {
  const raw = str(env[key]);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new ScrapeError({
      code: 'config_error',
      message: `invalid configuration — ${key} must be a number, received "${raw}"`,
    });
  }
  return parsed;
}

function int(env: EnvSource, key: string, fallback: number): number {
  const parsed = num(env, key, fallback);
  if (!Number.isInteger(parsed)) {
    throw new ScrapeError({
      code: 'config_error',
      message: `invalid configuration — ${key} must be an integer, received "${String(env[key])}"`,
    });
  }
  return parsed;
}

function bool(env: EnvSource, key: string, fallback: boolean): boolean {
  const raw = str(env[key])?.toLowerCase();
  if (raw === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new ScrapeError({
    code: 'config_error',
    message: `invalid configuration — ${key} must be a boolean, received "${raw}"`,
  });
}
