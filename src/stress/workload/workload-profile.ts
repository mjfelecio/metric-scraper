import { type InstagramScenario, type TikTokScenario } from './scenario.js';

export interface LatencyRange {
  minMs: number;
  maxMs: number;
}

export interface ResponseSizeConfig {
  /** Approximate wire size, in bytes, each mock response body is padded to. */
  targetBytes: number;
}

export interface TikTokWorkloadProfile {
  scenarios: Partial<Record<TikTokScenario, number>>;
  /** For `retry_then_success`: how many embed attempts fail before succeeding. */
  retryFailFirstN: number;
  latency: LatencyRange;
  responseSize: ResponseSizeConfig;
}

export interface InstagramWorkloadProfile {
  scenarios: Partial<Record<InstagramScenario, number>>;
  clipsMaxPages: number;
  clipsMaxAuthors: number;
  latency: LatencyRange;
  responseSize: ResponseSizeConfig;
}

export interface WorkloadProfile {
  seed: number;
  tiktok: TikTokWorkloadProfile;
  instagram: InstagramWorkloadProfile;
}

/** Observed range from the task brief: ~25-28KB per HTTP request. */
const DEFAULT_RESPONSE_SIZE: ResponseSizeConfig = { targetBytes: 26_000 };
const DEFAULT_LATENCY: LatencyRange = { minMs: 50, maxMs: 500 };

/**
 * Mostly-successful mix, close to what a healthy live run looks like. TikTok
 * weights mirror the task brief's own example (95% success / 2% 429 / 1% 403
 * / 1% timeout / 1% 500). Instagram weights mirror its example path
 * distribution (fast 30% / clips-page-1 40% / deeper clips 20% / exhausted+
 * fallback 10%), with a small slice of that redistributed to failures so the
 * profile is not implausibly perfect.
 */
export const NORMAL_WORKLOAD_PROFILE: WorkloadProfile = {
  seed: 1,
  tiktok: {
    scenarios: {
      normal: 95,
      embed_429: 2,
      embed_403: 1,
      embed_timeout: 1,
      embed_500: 1,
    },
    retryFailFirstN: 2,
    latency: DEFAULT_LATENCY,
    responseSize: DEFAULT_RESPONSE_SIZE,
  },
  instagram: {
    scenarios: {
      fast_path: 27,
      clips_page1: 36,
      clips_page2: 12,
      clips_deep: 15,
      clips_exhausted: 5,
      post_429: 2,
      post_403: 1,
      post_timeout: 1,
      post_500: 1,
    },
    clipsMaxPages: 2,
    clipsMaxAuthors: 3,
    latency: DEFAULT_LATENCY,
    responseSize: DEFAULT_RESPONSE_SIZE,
  },
};

/** Elevated 429/403/timeout rates, for the failure-heavy stress profile. */
export const FAILURE_HEAVY_WORKLOAD_PROFILE: WorkloadProfile = {
  seed: 2,
  tiktok: {
    scenarios: {
      normal: 40,
      embed_429: 25,
      embed_403: 15,
      embed_timeout: 10,
      embed_500: 5,
      player_429: 3,
      player_500: 2,
    },
    retryFailFirstN: 2,
    latency: DEFAULT_LATENCY,
    responseSize: DEFAULT_RESPONSE_SIZE,
  },
  instagram: {
    scenarios: {
      fast_path: 15,
      clips_page1: 15,
      clips_page2: 10,
      clips_deep: 10,
      clips_exhausted: 5,
      post_429: 25,
      post_403: 10,
      post_timeout: 8,
      post_500: 2,
    },
    clipsMaxPages: 2,
    clipsMaxAuthors: 3,
    latency: { minMs: 100, maxMs: 1000 },
    responseSize: DEFAULT_RESPONSE_SIZE,
  },
};

/** Every request succeeds on the first try, minimal latency. Baseline profile. */
export const CLEAN_WORKLOAD_PROFILE: WorkloadProfile = {
  seed: 3,
  tiktok: {
    scenarios: { normal: 1 },
    retryFailFirstN: 2,
    latency: { minMs: 0, maxMs: 50 },
    responseSize: DEFAULT_RESPONSE_SIZE,
  },
  instagram: {
    scenarios: { fast_path: 1 },
    clipsMaxPages: 2,
    clipsMaxAuthors: 3,
    latency: { minMs: 0, maxMs: 50 },
    responseSize: DEFAULT_RESPONSE_SIZE,
  },
};

export const NAMED_WORKLOAD_PROFILES = {
  normal: NORMAL_WORKLOAD_PROFILE,
  'failure-heavy': FAILURE_HEAVY_WORKLOAD_PROFILE,
  clean: CLEAN_WORKLOAD_PROFILE,
} as const;

export type NamedWorkloadProfile = keyof typeof NAMED_WORKLOAD_PROFILES;
