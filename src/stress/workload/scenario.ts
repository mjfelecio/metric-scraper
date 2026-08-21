import { createHash } from 'node:crypto';

/**
 * Deterministic scenario selection for the stress harness's mock upstreams.
 *
 * Every decision here is a pure function of `(seed, key)`. There is
 * deliberately no shared mutable "current scenario" state: two concurrent
 * mock requests for the same synthetic id (e.g. the same URL scraped several
 * times in one run, or a retry racing a fresh attempt) must independently
 * derive the same answer without coordinating, or the embed/player and
 * post/clips request pairs could disagree with each other under load. See
 * `docs/stress-testing.md` for the reasoning.
 */

/**
 * SHA-256 of `${seed}:${key}`, normalized into `[0, 1)`.
 *
 * A hand-rolled FNV-1a variant was tried first and measured to have
 * pathologically poor avalanche for this call shape -- long, mostly-shared
 * key prefixes (`tiktok:7000000000000010` vs `...011`) -- to the point that
 * `seed` had *no* measurable effect at all. `crypto.createHash` costs
 * microseconds per call, which is irrelevant next to a mocked HTTP
 * round-trip, so correctness of the distribution wins over hand-rolling.
 */
export function hashToUnitInterval(seed: number, key: string): number {
  const digest = createHash('sha256').update(`${seed}:${key}`).digest();
  return digest.readUInt32BE(0) / 0x100000000;
}

/**
 * Picks a key from `weights` proportional to its weight, given a uniform
 * `unit` in `[0, 1)`. Zero/negative/missing weights are treated as excluded.
 */
export function pickWeighted<T extends string>(
  unit: number,
  weights: Partial<Record<T, number>>,
): T {
  const entries = Object.entries(weights) as [T, number][];
  const positive = entries.filter(([, weight]) => weight > 0);
  if (positive.length === 0) {
    throw new Error('workload profile has no positive scenario weights');
  }
  const total = positive.reduce((sum, [, weight]) => sum + weight, 0);
  let cursor = unit * total;
  for (const [key, weight] of positive) {
    cursor -= weight;
    if (cursor <= 0) return key;
  }
  // Floating-point rounding at the boundary: fall back to the last bucket.
  const last = positive[positive.length - 1];
  if (last === undefined) throw new Error('unreachable: positive is non-empty');
  return last[0];
}

/** Uniform latency in `[minMs, maxMs]`, deterministic given `(seed, key)`. */
export function pickLatencyMs(
  seed: number,
  key: string,
  range: { minMs: number; maxMs: number },
): number {
  if (range.maxMs <= range.minMs) return Math.max(0, range.minMs);
  const unit = hashToUnitInterval(seed, `latency:${key}`);
  return Math.round(range.minMs + unit * (range.maxMs - range.minMs));
}

export const TIKTOK_SCENARIOS = [
  'normal',
  'embed_403',
  'embed_429',
  'embed_500',
  'embed_timeout',
  'embed_not_found',
  'embed_challenge',
  'player_403',
  'player_429',
  'player_500',
  'player_timeout',
  'retry_then_success',
] as const;

export type TikTokScenario = (typeof TIKTOK_SCENARIOS)[number];

export const INSTAGRAM_SCENARIOS = [
  'fast_path',
  'clips_page1',
  'clips_page2',
  'clips_deep',
  'clips_exhausted',
  'post_403',
  'post_429',
  'post_500',
  'post_timeout',
  'post_not_found',
  'post_malformed',
  'post_missing_fields',
] as const;

export type InstagramScenario = (typeof INSTAGRAM_SCENARIOS)[number];

export function pickTikTokScenario(
  videoId: string,
  weights: Partial<Record<TikTokScenario, number>>,
  seed: number,
): TikTokScenario {
  return pickWeighted(hashToUnitInterval(seed, `tiktok:${videoId}`), weights);
}

export function pickInstagramScenario(
  shortcode: string,
  weights: Partial<Record<InstagramScenario, number>>,
  seed: number,
): InstagramScenario {
  return pickWeighted(hashToUnitInterval(seed, `instagram:${shortcode}`), weights);
}

/**
 * For `clips_deep`/`clips_exhausted`: which zero-based author index (among up
 * to `maxAuthors`) and which one-based page carries the match, or `null` when
 * the scenario never finds one. Deterministic given `(shortcode, seed)`, so
 * every clips request for the same shortcode agrees independently of call
 * order.
 */
export function pickInstagramMatchLocation(
  shortcode: string,
  scenario: InstagramScenario,
  seed: number,
  maxAuthors: number,
  maxPages: number,
): { authorIndex: number; page: number } | null {
  switch (scenario) {
    case 'clips_page1':
      return { authorIndex: 0, page: 1 };
    case 'clips_page2':
      return { authorIndex: 0, page: Math.min(2, maxPages) };
    case 'clips_deep': {
      // Anywhere from the second author onward, on some page -- deterministic
      // but varied across shortcodes so "deep" runs cost different amounts.
      const authorUnit = hashToUnitInterval(seed, `${shortcode}:deep-author`);
      const pageUnit = hashToUnitInterval(seed, `${shortcode}:deep-page`);
      const authorIndex = 1 + Math.floor(authorUnit * Math.max(1, maxAuthors - 1));
      const page = 1 + Math.floor(pageUnit * maxPages);
      return { authorIndex: Math.min(authorIndex, maxAuthors - 1), page: Math.min(page, maxPages) };
    }
    case 'fast_path':
    case 'clips_exhausted':
    case 'post_403':
    case 'post_429':
    case 'post_500':
    case 'post_timeout':
    case 'post_not_found':
    case 'post_malformed':
    case 'post_missing_fields':
      return null;
  }
}
