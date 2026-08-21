import { type MockAgent } from 'undici';

import {
  hashToUnitInterval,
  pickInstagramMatchLocation,
  pickInstagramScenario,
  pickLatencyMs,
  type InstagramScenario,
} from '../workload/scenario.js';
import { type InstagramWorkloadProfile } from '../workload/workload-profile.js';

import {
  buildInstagramClipsJson,
  buildInstagramMediaInfoJson,
  buildInstagramPostJson,
  buildInstagramPostMissingFieldsJson,
  buildInstagramRootHtml,
  buildInstagramRootSetCookie,
  buildMalformedJson,
} from './fixtures/instagram-fixtures.js';
import { simulatedTimeoutError, type RequestTimingLookupInput } from './proxy-mock-dispatcher.js';

const WEB_ORIGIN = 'https://www.instagram.com';
const MOBILE_ORIGIN = 'https://i.instagram.com';
const GRAPHQL_PATH = '/graphql/query';
const MEDIA_INFO_PATH = /^\/api\/v1\/media\/(\d+)\/info\/?$/;
/** Matches `synthetic-input.ts`'s `instagramSyntheticShortcode` -- 1-digit prefix + 11 digits. */
const SYNTHETIC_SHORTCODE_LENGTH = 12;

export interface InstagramMockUpstreamOptions {
  postDocId: string;
  clipsDocId: string;
}

/**
 * Registers Instagram's four real endpoints (anonymous CSRF root, post
 * GraphQL, clips GraphQL, authenticated media-info) across two origins on a
 * shared `MockAgent`.
 *
 * The *scenario* for a shortcode is a pure function of `(seed, shortcode)`,
 * including which author/page a `clips_*` match lands on
 * (`pickInstagramMatchLocation`), with no shared mutable state needed for
 * that lookup -- a clips request carries only `target_user_id` + `max_id`,
 * never the shortcode, so author ids are synthesized as
 * `${role}${shortcode}` (see `synthetic-input.ts`) and losslessly decoded
 * back on every request rather than looked up in a map.
 *
 * Whether a *retryable* post failure (403/429/500) actually fails is not
 * state-free, though: it fails only on a shortcode's first post attempt and
 * succeeds on every retry, tracked via a small per-shortcode occurrence
 * counter -- the same reasoning as TikTok's mock upstream (see its
 * class-level doc comment): a retry leases a fresh proxy, and a block is
 * usually a fact about the exit node, not the URL. `post_not_found` /
 * `post_malformed` / `post_missing_fields` stay permanent regardless of
 * occurrence -- they are non-retryable in the real scraper (`parse_error`/
 * `not_found`), and unlike a transient block, a genuinely deleted or
 * malformed post does not "come back" on a later, independent scrape of the
 * same URL.
 */
export function registerInstagramMockUpstream(
  mockAgent: MockAgent,
  profile: InstagramWorkloadProfile,
  seed: number,
  options: InstagramMockUpstreamOptions,
): void {
  const webPool = mockAgent.get(WEB_ORIGIN);
  const mobilePool = mockAgent.get(MOBILE_ORIGIN);
  const postOccurrences = new Map<string, number>();

  webPool
    .intercept({ path: '/', method: 'GET' })
    .reply(() => ({
      statusCode: 200,
      data: buildInstagramRootHtml(profile.responseSize.targetBytes),
      responseOptions: {
        headers: {
          ...htmlHeaders(),
          'set-cookie': buildInstagramRootSetCookie('stress-csrf-token'),
        },
      },
    }))
    .persist();

  // Registered ahead of the normal post reply below: a genuine transport
  // failure can only come from a matched `.replyWithError()` interceptor --
  // see `simulatedTimeoutError`'s doc comment. The body predicate
  // recomputes the same deterministic scenario pick used below.
  webPool
    .intercept({
      path: GRAPHQL_PATH,
      method: 'POST',
      body: (body) =>
        body.includes(`doc_id=${options.postDocId}`) &&
        pickInstagramScenario(extractShortcode(body), profile.scenarios, seed) === 'post_timeout',
    })
    .replyWithError(simulatedTimeoutError('simulated Instagram post_timeout'))
    .persist();

  webPool
    .intercept({
      path: GRAPHQL_PATH,
      method: 'POST',
      body: (body) => body.includes(`doc_id=${options.postDocId}`),
    })
    .reply((opts) => {
      const shortcode = extractShortcode(opts.body);
      const scenario = pickInstagramScenario(shortcode, profile.scenarios, seed);
      const occurrence = (postOccurrences.get(shortcode) ?? 0) + 1;
      postOccurrences.set(shortcode, occurrence);
      return buildPostReply(shortcode, scenario, profile, seed, occurrence);
    })
    .persist();

  webPool
    .intercept({
      path: GRAPHQL_PATH,
      method: 'POST',
      body: (body) => body.includes(`doc_id=${options.clipsDocId}`),
    })
    .reply((opts) => {
      const { authorId, cursor } = extractClipsQuery(opts.body);
      const { role, shortcode } = decodeAuthorId(authorId);
      const scenario = pickInstagramScenario(shortcode, profile.scenarios, seed);
      const match = pickInstagramMatchLocation(
        shortcode,
        scenario,
        seed,
        profile.clipsMaxAuthors,
        profile.clipsMaxPages,
      );
      const currentPage = cursor === null ? 1 : Number(cursor);
      const found = match !== null && match.authorIndex === role && match.page === currentPage;

      const data = found
        ? {
            match: { shortcode, playCount: derivePlayCount(shortcode, seed) },
            hasNextPage: false,
            endCursor: null,
          }
        : currentPage < profile.clipsMaxPages
          ? { match: null, hasNextPage: true, endCursor: String(currentPage + 1) }
          : { match: null, hasNextPage: false, endCursor: null };

      return {
        statusCode: 200,
        data: buildInstagramClipsJson({ ...data, targetBytes: profile.responseSize.targetBytes }),
        responseOptions: { headers: jsonHeaders() },
      };
    })
    .persist();

  mobilePool
    .intercept({ path: (path) => MEDIA_INFO_PATH.test(path), method: 'GET' })
    .reply((opts) => {
      const match = MEDIA_INFO_PATH.exec(opts.path);
      const mediaId = match?.[1];
      if (mediaId === undefined) throw new Error(`unmatched media-info path: ${opts.path}`);
      const shortcode = mediaIdToSyntheticShortcode(mediaId);
      const metrics = deriveInstagramMetrics(shortcode, seed);
      return {
        statusCode: 200,
        data: buildInstagramMediaInfoJson({
          shortcode,
          playCount: derivePlayCount(shortcode, seed),
          likeCount: metrics.likeCount,
          commentCount: metrics.commentCount,
          takenAtSeconds: metrics.takenAtSeconds,
          authorHandle: metrics.authorHandle,
          targetBytes: profile.responseSize.targetBytes,
        }),
        responseOptions: { headers: jsonHeaders() },
      };
    })
    .persist();
}

function buildPostReply(
  shortcode: string,
  scenario: InstagramScenario,
  profile: InstagramWorkloadProfile,
  seed: number,
  occurrence: number,
): { statusCode: number; data: string; responseOptions: { headers: Record<string, string> } } {
  const targetBytes = profile.responseSize.targetBytes;
  const found = (): {
    statusCode: 200;
    data: string;
    responseOptions: { headers: Record<string, string> };
  } => {
    const metrics = deriveInstagramMetrics(shortcode, seed);
    return {
      statusCode: 200,
      data: buildInstagramPostJson({
        shortcode,
        mediaPk: shortcode,
        playCount: derivePlayCount(shortcode, seed),
        likeCount: metrics.likeCount,
        commentCount: metrics.commentCount,
        takenAtSeconds: metrics.takenAtSeconds,
        authorId: encodeAuthorId(shortcode, 0),
        authorHandle: metrics.authorHandle,
        targetBytes,
      }),
      responseOptions: { headers: jsonHeaders() },
    };
  };

  // Retryable post failures (403/429/500) fail only on a shortcode's first
  // attempt and succeed on every retry -- see the class-level doc comment.
  // `post_not_found`/`post_malformed`/`post_missing_fields` are permanent
  // regardless of occurrence: non-retryable in the real scraper, and unlike
  // a transient block these are facts about the post/response shape that
  // don't change on a later, independent scrape of the same URL.
  switch (scenario) {
    case 'post_403':
      return occurrence > 1
        ? found()
        : { statusCode: 403, data: '', responseOptions: { headers: textHeaders() } };
    case 'post_429':
      return occurrence > 1
        ? found()
        : { statusCode: 429, data: '', responseOptions: { headers: textHeaders() } };
    case 'post_500':
      return occurrence > 1
        ? found()
        : { statusCode: 500, data: '', responseOptions: { headers: textHeaders() } };
    case 'post_not_found':
      return { statusCode: 404, data: '', responseOptions: { headers: textHeaders() } };
    case 'post_malformed':
      return {
        statusCode: 200,
        data: buildMalformedJson(),
        responseOptions: { headers: jsonHeaders() },
      };
    case 'post_missing_fields': {
      const metrics = deriveInstagramMetrics(shortcode, seed);
      return {
        statusCode: 200,
        data: buildInstagramPostMissingFieldsJson({
          shortcode,
          authorId: encodeAuthorId(shortcode, 0),
          authorHandle: metrics.authorHandle,
          targetBytes,
        }),
        responseOptions: { headers: jsonHeaders() },
      };
    }
    case 'post_timeout':
      // Never reached: the timing interceptor injects a transport error first.
      throw new Error('post_timeout should have been intercepted before reaching MockAgent');
    case 'fast_path':
      return found();
    case 'clips_page1':
    case 'clips_page2':
    case 'clips_deep':
    case 'clips_exhausted': {
      // Post has no play_count, forcing the real scraper into its clips lookup.
      const metrics = deriveInstagramMetrics(shortcode, seed);
      const coauthorCount = Math.max(0, profile.clipsMaxAuthors - 1);
      const coauthorIds = Array.from({ length: coauthorCount }, (_, index) =>
        encodeAuthorId(shortcode, index + 1),
      );
      return {
        statusCode: 200,
        data: buildInstagramPostJson({
          shortcode,
          mediaPk: shortcode,
          playCount: null,
          likeCount: metrics.likeCount,
          commentCount: metrics.commentCount,
          takenAtSeconds: metrics.takenAtSeconds,
          authorId: encodeAuthorId(shortcode, 0),
          authorHandle: metrics.authorHandle,
          coauthorIds,
          targetBytes,
        }),
        responseOptions: { headers: jsonHeaders() },
      };
    }
  }
}

/**
 * Stateless latency decision for the shared timing interceptor
 * (`proxy-mock-dispatcher.ts`). Timeout scenarios are handled separately by
 * the `.replyWithError()` registration above, not here -- see
 * `simulatedTimeoutError`'s doc comment.
 */
export function computeInstagramRequestLatencyMs(
  opts: RequestTimingLookupInput,
  profile: InstagramWorkloadProfile,
  seed: number,
  docIds: InstagramMockUpstreamOptions,
): number {
  if (opts.path === '/') {
    return pickLatencyMs(seed, 'instagram:root', profile.latency);
  }
  if (opts.path === GRAPHQL_PATH && typeof opts.body === 'string') {
    if (opts.body.includes(`doc_id=${docIds.postDocId}`)) {
      const shortcode = extractShortcode(opts.body);
      return pickLatencyMs(seed, `instagram:${shortcode}:post`, profile.latency);
    }
    if (opts.body.includes(`doc_id=${docIds.clipsDocId}`)) {
      const { authorId } = extractClipsQuery(opts.body);
      return pickLatencyMs(seed, `instagram:clips:${authorId}`, profile.latency);
    }
  }
  if (MEDIA_INFO_PATH.test(opts.path)) {
    return pickLatencyMs(seed, `instagram:media-info:${opts.path}`, profile.latency);
  }
  return 0;
}

function extractShortcode(body: unknown): string {
  const variables = readVariables(body);
  const shortcode = (variables as { shortcode?: unknown }).shortcode;
  if (typeof shortcode !== 'string') {
    throw new Error('mock Instagram post request is missing a shortcode variable');
  }
  return shortcode;
}

function extractClipsQuery(body: unknown): { authorId: string; cursor: string | null } {
  const variables = readVariables(body) as {
    data?: { target_user_id?: unknown; max_id?: unknown };
  };
  const authorId = variables.data?.target_user_id;
  if (typeof authorId !== 'string') {
    throw new Error('mock Instagram clips request is missing target_user_id');
  }
  const cursor = variables.data?.max_id;
  return { authorId, cursor: typeof cursor === 'string' ? cursor : null };
}

function readVariables(body: unknown): unknown {
  if (typeof body !== 'string') throw new Error('mock Instagram request body must be a string');
  const variables = new URLSearchParams(body).get('variables');
  if (variables === null) throw new Error('mock Instagram request is missing the variables field');
  return JSON.parse(variables);
}

/** `${roleDigit}${shortcode}` -- purely numeric, losslessly invertible, no lookup table needed. */
function encodeAuthorId(shortcode: string, role: number): string {
  return `${role}${shortcode}`;
}

function decodeAuthorId(authorId: string): { role: number; shortcode: string } {
  return { role: Number(authorId[0]), shortcode: authorId.slice(1) };
}

/**
 * Inverse of `shortcodeToMediaId` (`src/platforms/instagram/instagram-shortcode.ts`)
 * for this module's synthetic shortcodes specifically: they are always
 * `SYNTHETIC_SHORTCODE_LENGTH` purely-numeric characters, which are digits
 * 52-61 in the real alphabet (`0-9` follow the 52 letters). That fixed length
 * and fixed digit range is what makes the base-64 positional encoding
 * invertible here without needing a lookup table.
 */
function mediaIdToSyntheticShortcode(mediaId: string): string {
  let value = BigInt(mediaId);
  const characters = new Array<string>(SYNTHETIC_SHORTCODE_LENGTH);
  for (let index = SYNTHETIC_SHORTCODE_LENGTH - 1; index >= 0; index -= 1) {
    const alphabetIndex = Number(value % 64n);
    characters[index] = String(alphabetIndex - 52);
    value /= 64n;
  }
  return characters.join('');
}

interface DerivedInstagramMetrics {
  likeCount: number;
  commentCount: number;
  takenAtSeconds: number;
  authorHandle: string;
}

function derivePlayCount(shortcode: string, seed: number): number {
  const unit = hashToUnitInterval(seed, `instagram:${shortcode}:views`);
  return 1_000 + Math.floor(unit * 9_999_000);
}

/** Plausible, deterministic-per-shortcode engagement numbers -- cosmetic only. */
function deriveInstagramMetrics(shortcode: string, seed: number): DerivedInstagramMetrics {
  const playCount = derivePlayCount(shortcode, seed);
  const likeCount = Math.floor(
    playCount * (0.01 + 0.05 * hashToUnitInterval(seed, `instagram:${shortcode}:likes`)),
  );
  const commentCount = Math.floor(
    likeCount * (0.01 + 0.03 * hashToUnitInterval(seed, `instagram:${shortcode}:comments`)),
  );
  return {
    likeCount,
    commentCount,
    takenAtSeconds:
      1_650_000_000 +
      Math.floor(hashToUnitInterval(seed, `instagram:${shortcode}:time`) * 100_000_000),
    authorHandle: `stressuser${shortcode.slice(-6)}`,
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
