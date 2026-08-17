import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

import { ScrapeError } from '../core/models/errors.js';

const LogLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']);

export const AppConfigSchema = z.object({
  logLevel: LogLevelSchema,

  concurrency: z.number().int().min(1).max(1_000),
  /** `0` disables pacing entirely. */
  targetRpm: z.number().int().min(0),
  /** `0` means an unbounded queue. */
  maxQueueSize: z.number().int().min(0),
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

  const candidate = {
    logLevel: str(env.LOG_LEVEL) ?? 'info',

    concurrency: int(env, 'SCRAPER_CONCURRENCY', 10),
    targetRpm: int(env, 'SCRAPER_TARGET_RPM', 500),
    maxQueueSize: int(env, 'SCRAPER_MAX_QUEUE_SIZE', 0),
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

  return parsed.data;
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
    maxQueueSize: config.maxQueueSize,
    requestTimeoutMs: config.requestTimeoutMs,
    retry: config.retry,
    outputDir: config.outputDir,
    proxy: { configured: proxyCount },
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
