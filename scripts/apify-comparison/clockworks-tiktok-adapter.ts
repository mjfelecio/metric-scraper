import { parseCanonicalTikTokUrl } from '../../src/platforms/tiktok/tiktok-url-normalizer.js';

import { type ActorAdapter, type NormalizedRow, type NormalizedRowOk } from './actor-adapter.js';
import { EMPTY_METRICS, type BenchmarkMetrics, type BenchmarkTarget } from './types.js';

/**
 * Adapter for `clockworks/tiktok-scraper`.
 *
 * Two jobs, both narrow: build the cheapest input that still answers the view
 * question, and read the output without trusting its shape.
 */
export class ClockworksTikTokAdapter implements ActorAdapter {
  readonly actorId = 'clockworks/tiktok-scraper';

  /**
   * The minimum viable Actor input: direct post URLs and nothing else.
   *
   * Every `shouldDownload*` flag is set explicitly to `false` rather than left
   * to the Actor's defaults. Defaults are the vendor's to change, and on a
   * per-result pricing model a silently re-enabled media download is both a
   * bandwidth bill and a pile of binary data this benchmark has no use for.
   * Setting a flag the Actor does not have costs nothing; failing to set one it
   * does have costs money.
   */
  buildInput(targets: readonly BenchmarkTarget[]): Record<string, unknown> {
    return {
      postURLs: targets.map((target) => target.url),
      resultsPerPage: targets.length,

      // No discovery of any kind: the benchmark asks about exactly the posts it
      // was given, so hashtag, profile and search inputs stay empty.
      searchQueries: [],
      hashtags: [],
      profiles: [],

      scrapeRelatedVideos: false,
      scrapeAdditionalAuthorMeta: false,

      shouldDownloadVideos: false,
      shouldDownloadCovers: false,
      shouldDownloadAvatars: false,
      shouldDownloadMusicCovers: false,
      shouldDownloadSlideshowImages: false,

      shouldDownloadSubtitles: false,
      shouldTranscribeVideos: false,

      // Comments and their replies are separately priced on most TikTok Actors
      // and are not part of the question being asked.
      commentsPerPost: 0,
      repliesPerComment: 0,
    };
  }

  describeFeatureFlags(input: Record<string, unknown>): Record<string, unknown> {
    const flags: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (key === 'postURLs') continue;
      if (typeof value === 'boolean' || typeof value === 'number') flags[key] = value;
    }
    return flags;
  }

  /**
   * Reads one dataset row.
   *
   * Handles both output shapes this Actor family has used: flat
   * (`playCount` at the top level) and nested (`stats.playCount`). Anything
   * unrecognised becomes `null`, never `0` — a zero would silently claim the
   * post has no views, which is the single most damaging thing this benchmark
   * could get wrong.
   */
  normalizeRow(row: unknown): NormalizedRow {
    if (!isRecord(row)) {
      return { kind: 'error', videoId: null, url: null, message: 'dataset row was not an object' };
    }

    const url = firstString(row.webVideoUrl, row.submittedVideoUrl, row.postPage, row.url);
    const videoId = readVideoId(row, url);

    const errorMessage = readErrorMessage(row);
    if (errorMessage !== null) {
      return { kind: 'error', videoId, url, message: errorMessage };
    }

    return { kind: 'ok', videoId, url, metrics: readMetrics(row) } satisfies NormalizedRowOk;
  }
}

function readMetrics(row: Record<string, unknown>): BenchmarkMetrics {
  const stats = isRecord(row.stats) ? row.stats : {};
  const author = isRecord(row.authorMeta) ? row.authorMeta : isRecord(row.author) ? row.author : {};
  const authorStats = isRecord(row.authorStats) ? row.authorStats : {};

  return {
    ...EMPTY_METRICS,
    views: count(row.playCount, stats.playCount),
    likes: count(row.diggCount, stats.diggCount),
    comments: count(row.commentCount, stats.commentCount),
    shares: count(row.shareCount, stats.shareCount),
    saves: count(row.collectCount, stats.collectCount),
    authorHandle: firstString(author.name, author.uniqueId, author.nickName),
    // `signature` is TikTok's own name for the public profile bio.
    authorBio: firstString(author.signature, author.bio),
    authorFollowerCount: count(author.fans, author.followerCount, authorStats.followerCount),
    postedAt: readPostedAt(row),
  };
}

function readPostedAt(row: Record<string, unknown>): string | null {
  const iso = firstString(row.createTimeISO);
  if (iso !== null && !Number.isNaN(Date.parse(iso))) return iso;

  const epoch = count(row.createTime);
  if (epoch === null || epoch <= 0) return null;
  // TikTok's `createTime` is seconds; a value large enough to be milliseconds
  // is treated as such rather than being read as a date in the year 50,000.
  const ms = epoch > 1e12 ? epoch : epoch * 1_000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function readVideoId(row: Record<string, unknown>, url: string | null): string | null {
  const direct = firstString(row.id, row.videoId, row.itemId);
  if (direct !== null && /^\d+$/.test(direct)) return direct;
  if (url === null) return null;
  return parseCanonicalTikTokUrl(url)?.videoId ?? null;
}

/** Actor error rows vary in shape; all of these have been seen in the wild. */
function readErrorMessage(row: Record<string, unknown>): string | null {
  const message = firstString(row.error, row.errorMessage, row.errorDescription);
  if (message !== null && message.length > 0) return message;
  if (row.error === true) return 'the Actor flagged this row as an error without a message';
  return null;
}

/**
 * A count, or `null`.
 *
 * Accepts the numeric strings TikTok payloads sometimes carry, and rejects
 * everything else — including `NaN`, negatives and non-integers. Absence and
 * malformation are the same answer here: we do not know.
 */
function count(...candidates: readonly unknown[]): number | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'number') {
      if (Number.isSafeInteger(candidate) && candidate >= 0) return candidate;
      continue;
    }
    if (typeof candidate === 'string' && /^\d+$/.test(candidate.trim())) {
      const parsed = Number(candidate.trim());
      if (Number.isSafeInteger(parsed)) return parsed;
    }
  }
  return null;
}

function firstString(...candidates: readonly unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim();
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
