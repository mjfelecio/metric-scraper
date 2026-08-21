import { type MockAgent } from 'undici';

import { type TikTokWorkloadProfile } from '../workload/workload-profile.js';
import { hashToUnitInterval, pickLatencyMs, pickTikTokScenario } from '../workload/scenario.js';

import {
  buildTikTokChallengeHtml,
  buildTikTokEmbedHtml,
  buildTikTokPlayerJson,
} from './fixtures/tiktok-fixtures.js';
import { simulatedTimeoutError, type RequestTimingLookupInput } from './proxy-mock-dispatcher.js';

const TIKTOK_ORIGIN = 'https://www.tiktok.com';
const EMBED_PATH = /^\/embed\/v2\/(\d+)\/?(?:\?.*)?$/;
const PLAYER_PATH_PREFIX = '/player/api/v1/items';

export interface TikTokMockUpstream {
  register: (mockAgent: MockAgent) => void;
  computeLatencyMs: (opts: RequestTimingLookupInput) => number;
}

/**
 * Builds TikTok's mock upstream: registers its two real endpoints (embed
 * page, player API) on a shared `MockAgent`, and a `computeLatencyMs` for
 * the timing interceptor (`proxy-mock-dispatcher.ts`) to call.
 *
 * The *scenario* for a given id is a pure function of `(seed, videoId)`, but
 * whether a retryable failure (403/429/500/challenge/timeout) actually
 * fails is not: it fails only on an id's first attempt and succeeds on
 * every retry, tracked via a small per-id occurrence counter. This models
 * real transient rate-limiting -- a retry leases a fresh proxy, and a block
 * is usually a fact about the *exit node*, not the URL. Without this, a
 * fixed-per-id failure would keep failing identically no matter which proxy
 * retried it, so every proxy that ever touched an unlucky id would
 * eventually get blamed and benched -- measured (FP-001 in
 * `docs/failure-points.md`) to cascade a 10-proxy pool into full exhaustion
 * at the default profile's ~5% TikTok failure rate, which overstates real
 * risk. `embed_not_found` is the one exception left permanent: it is
 * non-retryable in the real scraper, so occurrence never exceeds 1 for it
 * anyway. `retry_then_success` is the other deliberate exception -- its
 * whole point is a *configurable* fail-count, so it keeps its own counter
 * logic. See `docs/stress-testing.md`'s concurrency-correctness note for
 * why per-id mutable state here is safe (benign, non-correctness-affecting
 * nondeterminism only under heavy concurrency on a deliberately-repeated
 * identical URL).
 *
 * The occurrence counter is incremented in exactly one place --
 * `computeLatencyMs`, for embed calls only -- because it is the only piece
 * of this module guaranteed to run exactly once per dispatch, *before*
 * `MockAgent`'s own interceptor matching (including the `embed_timeout`/
 * `player_timeout` error interceptors below, which need to read the current
 * occurrence from their *matching predicate*, not from a reply callback
 * that only runs once a match has already been chosen). Every other
 * consumer (both reply callbacks, both error predicates) only reads it.
 */
export function createTikTokMockUpstream(
  profile: TikTokWorkloadProfile,
  seed: number,
): TikTokMockUpstream {
  const embedOccurrences = new Map<string, number>();

  function occurrenceOf(videoId: string): number {
    return embedOccurrences.get(videoId) ?? 0;
  }

  function register(mockAgent: MockAgent): void {
    const pool = mockAgent.get(TIKTOK_ORIGIN);

    // Registered ahead of the normal reply callback below: MockAgent tries
    // interceptors in registration order, and a genuine transport-level
    // failure can only be produced through `.replyWithError()` on a matched
    // interceptor -- see `simulatedTimeoutError`'s doc comment for why this
    // can't be done by inspecting the scenario inside `.reply()` instead.
    // Fires only on the id's first occurrence, matching every other
    // retryable failure type.
    pool
      .intercept({
        path: (path) =>
          EMBED_PATH.test(path) &&
          scenarioForEmbedPath(path, profile, seed) === 'embed_timeout' &&
          occurrenceOf(extractEmbedVideoId(path)) === 1,
        method: 'GET',
      })
      .replyWithError(simulatedTimeoutError('simulated TikTok embed_timeout'))
      .persist();

    pool
      .intercept({ path: (path) => EMBED_PATH.test(path), method: 'GET' })
      .reply((opts) => {
        const videoId = extractEmbedVideoId(opts.path);
        const scenario = pickTikTokScenario(videoId, profile.scenarios, seed);
        const metrics = deriveTikTokMetrics(videoId, seed);
        const targetBytes = profile.responseSize.targetBytes;
        // Already incremented by computeLatencyMs, which always runs first.
        const occurrence = occurrenceOf(videoId);
        const success = (): {
          statusCode: 200;
          data: string;
          responseOptions: { headers: Record<string, string> };
        } => ({
          statusCode: 200,
          data: buildTikTokEmbedHtml({ ...metrics, videoId, targetBytes }),
          responseOptions: { headers: htmlHeaders() },
        });

        if (scenario === 'retry_then_success') {
          return occurrence <= profile.retryFailFirstN
            ? { statusCode: 500, data: '', responseOptions: { headers: textHeaders() } }
            : success();
        }

        // Permanent regardless of occurrence: a deleted video is still
        // deleted on a later, independent scrape of the same URL (unlike a
        // transient rate-limit, this is a genuine fact about the video).
        // Checked before the occurrence gate below, which is only for
        // *retryable* failures.
        if (scenario === 'embed_not_found') {
          return { statusCode: 404, data: '', responseOptions: { headers: textHeaders() } };
        }

        // Every other retryable embed failure fails only on the first
        // attempt -- see the module-level doc comment for why.
        if (occurrence > 1) return success();

        switch (scenario) {
          case 'embed_403':
            return { statusCode: 403, data: '', responseOptions: { headers: textHeaders() } };
          case 'embed_429':
            return { statusCode: 429, data: '', responseOptions: { headers: textHeaders() } };
          case 'embed_500':
            return { statusCode: 500, data: '', responseOptions: { headers: textHeaders() } };
          case 'embed_challenge':
            return {
              statusCode: 200,
              data: buildTikTokChallengeHtml(targetBytes),
              responseOptions: { headers: htmlHeaders() },
            };
          case 'embed_timeout':
            // Never actually reached: the error interceptor above matches
            // first. Kept only so a profile misconfiguration fails loudly
            // rather than hanging.
            throw new Error('embed_timeout should have been intercepted before reaching MockAgent');
          case 'normal':
          case 'player_403':
          case 'player_429':
          case 'player_500':
          case 'player_timeout':
            return success();
        }
      })
      .persist();

    pool
      .intercept({
        path: (path) =>
          path.startsWith(PLAYER_PATH_PREFIX) &&
          scenarioForPlayerPath(path, profile, seed) === 'player_timeout' &&
          occurrenceOf(extractPlayerVideoId(path)) === 1,
        method: 'GET',
      })
      .replyWithError(simulatedTimeoutError('simulated TikTok player_timeout'))
      .persist();

    pool
      .intercept({ path: (path) => path.startsWith(PLAYER_PATH_PREFIX), method: 'GET' })
      .reply((opts) => {
        const videoId = extractPlayerVideoId(opts.path);
        const scenario = pickTikTokScenario(videoId, profile.scenarios, seed);
        const metrics = deriveTikTokMetrics(videoId, seed);
        const targetBytes = profile.responseSize.targetBytes;
        // Set by this same attempt's embed call, which always precedes
        // player. Only the first attempt for an id actually fails -- see
        // the module-level doc comment.
        const occurrence = occurrenceOf(videoId) || 1;
        const playerSuccess = (): {
          statusCode: 200;
          data: string;
          responseOptions: { headers: Record<string, string> };
        } => ({
          statusCode: 200,
          data: buildTikTokPlayerJson({ videoId, ...metrics, targetBytes }),
          responseOptions: { headers: jsonHeaders() },
        });
        if (occurrence > 1) return playerSuccess();

        switch (scenario) {
          case 'player_403':
            return { statusCode: 403, data: '', responseOptions: { headers: textHeaders() } };
          case 'player_429':
            return { statusCode: 429, data: '', responseOptions: { headers: textHeaders() } };
          case 'player_500':
            return { statusCode: 500, data: '', responseOptions: { headers: textHeaders() } };
          case 'player_timeout':
            throw new Error(
              'player_timeout should have been intercepted before reaching MockAgent',
            );
          case 'normal':
          case 'retry_then_success':
          case 'embed_403':
          case 'embed_429':
          case 'embed_500':
          case 'embed_timeout':
          case 'embed_not_found':
          case 'embed_challenge':
            return {
              statusCode: 200,
              data: buildTikTokPlayerJson({ videoId, ...metrics, targetBytes }),
              responseOptions: { headers: jsonHeaders() },
            };
        }
      })
      .persist();
  }

  function computeLatencyMs(opts: RequestTimingLookupInput): number {
    const isEmbed = EMBED_PATH.test(opts.path);
    const isPlayer = opts.path.startsWith(PLAYER_PATH_PREFIX);
    if (!isEmbed && !isPlayer) return 0;

    const videoId = isEmbed ? extractEmbedVideoId(opts.path) : extractPlayerVideoId(opts.path);
    if (isEmbed) {
      embedOccurrences.set(videoId, occurrenceOf(videoId) + 1);
    }
    return pickLatencyMs(
      seed,
      `tiktok:${videoId}:${isEmbed ? 'embed' : 'player'}`,
      profile.latency,
    );
  }

  return { register, computeLatencyMs };
}

function scenarioForEmbedPath(path: string, profile: TikTokWorkloadProfile, seed: number): string {
  return pickTikTokScenario(extractEmbedVideoId(path), profile.scenarios, seed);
}

function scenarioForPlayerPath(path: string, profile: TikTokWorkloadProfile, seed: number): string {
  return pickTikTokScenario(extractPlayerVideoId(path), profile.scenarios, seed);
}

function extractEmbedVideoId(path: string): string {
  const match = EMBED_PATH.exec(path);
  const id = match?.[1];
  if (id === undefined)
    throw new Error(`could not extract TikTok video id from embed path: ${path}`);
  return id;
}

function extractPlayerVideoId(path: string): string {
  const query = path.includes('?') ? path.slice(path.indexOf('?')) : '';
  const itemIds = new URLSearchParams(query).get('item_ids');
  if (itemIds === null || itemIds.length === 0) {
    throw new Error(`could not extract TikTok video id from player path: ${path}`);
  }
  return itemIds;
}

interface DerivedTikTokMetrics {
  createTimeSeconds: number;
  playCount: number;
  diggCount: number;
  commentCount: number;
  shareCount: number;
  authorHandle: string;
  followerCount: number;
  likes: number;
  comments: number;
  shares: number;
}

/** Plausible, deterministic-per-id engagement numbers -- cosmetic only. */
function deriveTikTokMetrics(videoId: string, seed: number): DerivedTikTokMetrics {
  const viewsUnit = hashToUnitInterval(seed, `tiktok:${videoId}:views`);
  const playCount = 1_000 + Math.floor(viewsUnit * 4_999_000);
  const likes = Math.floor(
    playCount * (0.02 + 0.08 * hashToUnitInterval(seed, `tiktok:${videoId}:likes`)),
  );
  const comments = Math.floor(
    likes * (0.01 + 0.04 * hashToUnitInterval(seed, `tiktok:${videoId}:comments`)),
  );
  const shares = Math.floor(
    likes * (0.005 + 0.02 * hashToUnitInterval(seed, `tiktok:${videoId}:shares`)),
  );
  const followerUnit = hashToUnitInterval(seed, `tiktok:${videoId}:followers`);
  return {
    createTimeSeconds:
      1_650_000_000 + Math.floor(hashToUnitInterval(seed, `tiktok:${videoId}:time`) * 100_000_000),
    playCount,
    diggCount: likes,
    commentCount: comments,
    shareCount: shares,
    authorHandle: `stressuser${videoId.slice(-6)}`,
    followerCount: 1_000 + Math.floor(followerUnit * 999_000),
    likes,
    comments,
    shares,
  };
}

function htmlHeaders(): Record<string, string> {
  return { 'content-type': 'text/html; charset=utf-8' };
}

function jsonHeaders(): Record<string, string> {
  return { 'content-type': 'application/json; charset=utf-8' };
}

function textHeaders(): Record<string, string> {
  return { 'content-type': 'text/plain; charset=utf-8' };
}
