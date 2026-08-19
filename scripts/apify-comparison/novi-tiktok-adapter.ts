import { parseCanonicalTikTokUrl } from '../../src/platforms/tiktok/tiktok-url-normalizer.js';

import { type ActorAdapter, type NormalizedRow, type NormalizedRowOk } from './actor-adapter.js';
import { count, epochToIso, firstString, isRecord } from './row-readers.js';
import { EMPTY_METRICS, type BenchmarkMetrics, type BenchmarkTarget } from './types.js';

/**
 * The Actor input schema requires `maxItems >= 20`, so it cannot be used to cap
 * a four-URL smoke test. The real bounds on spend are the number of URLs
 * submitted and the platform-level `maxTotalChargeUsd`; this constant only
 * keeps the input schema-valid.
 */
export const MIN_ACTOR_MAX_ITEMS = 20;

/**
 * Adapter for `novi/tiktok-scraper-ultimate`.
 *
 * The reason this Actor is worth paying for is that it is not in the same
 * family as `clockworks/tiktok-scraper`. Clockworks returns TikTok's *web*
 * payload shape (`playCount`, `authorMeta`, `webVideoUrl`), and TikTok rounds
 * `playCount` server-side above some threshold across that whole web API
 * family — which is the same rounded number our own scraper already reads off
 * `/embed/v2/`. Paying for a second read of the identical rounded value answers
 * nothing.
 *
 * This Actor returns TikTok's *mobile* payload shape instead: `aweme_id`,
 * `statistics.play_count`, `author.unique_id`, snake_case throughout. That is
 * the surface unrounded view counts are believed to come from. "Believed" is
 * the operative word — this adapter exists to test that claim, not to assume
 * it. A more granular number here is still not proof of an exact one.
 */
export class NoviTikTokAdapter implements ActorAdapter {
  readonly actorId = 'novi/tiktok-scraper-ultimate';

  /**
   * The entire input surface: URLs and a result cap.
   *
   * Unlike Clockworks, this Actor publishes **no** media-download, comment,
   * subtitle or AI options, so there is nothing to switch off. That absence is
   * deliberately not papered over with reassuring-looking `shouldDownloadVideos:
   * false` lines — Apify ignores unknown input fields silently, so inventing
   * them would put flags in the artifact that look like they protected the run
   * while doing nothing at all. What actually bounds this run is the URL count
   * and the charge ceiling, and the record should say only that.
   *
   * `keywords`, `dateRange`, `location` and `sortType` are search-mode fields
   * and are left unset: passing URLs and a search query at the same time is how
   * a four-video benchmark turns into a thousand-result bill.
   */
  buildInput(targets: readonly BenchmarkTarget[]): Record<string, unknown> {
    return {
      startUrls: targets.map((target) => target.url),
      maxItems: Math.max(MIN_ACTOR_MAX_ITEMS, targets.length),
    };
  }

  describeFeatureFlags(input: Record<string, unknown>): Record<string, unknown> {
    const flags: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (key === 'startUrls') continue;
      if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
        flags[key] = value;
      }
    }
    return flags;
  }

  /**
   * Reads one dataset row of TikTok's mobile payload.
   *
   * Counts live under `statistics`; the top-level spellings are a fallback for
   * a build that flattens them, consulted only when the nested field is absent.
   */
  normalizeRow(row: unknown): NormalizedRow {
    if (!isRecord(row)) {
      return { kind: 'error', videoId: null, url: null, message: 'dataset row was not an object' };
    }

    const url = firstString(row.share_url, row.shareUrl, row.url, row.webVideoUrl);
    const videoId = readVideoId(row, url);

    const errorMessage = readErrorMessage(row, videoId);
    if (errorMessage !== null) {
      return { kind: 'error', videoId, url, message: errorMessage };
    }

    return { kind: 'ok', videoId, url, metrics: readMetrics(row) } satisfies NormalizedRowOk;
  }
}

function readMetrics(row: Record<string, unknown>): BenchmarkMetrics {
  const stats = isRecord(row.statistics) ? row.statistics : {};
  const author = isRecord(row.author) ? row.author : {};

  return {
    ...EMPTY_METRICS,
    views: count(stats.play_count, row.play_count),
    likes: count(stats.digg_count, row.digg_count),
    comments: count(stats.comment_count, row.comment_count),
    shares: count(stats.share_count, row.share_count),
    saves: count(stats.collect_count, row.collect_count),
    authorHandle: firstString(author.unique_id, author.nickname),
    // `signature` is TikTok's own name for the public profile bio.
    authorBio: firstString(author.signature, author.bio),
    // The Actor's own sample output shows `follower_count: 0` on a populated
    // row, so a zero here may mean "not collected" rather than "no followers".
    // It is passed through unchanged rather than guessed at; follower count is
    // not one of COMPARABLE_METRICS, so it never reaches a delta.
    authorFollowerCount: count(author.follower_count, row.follower_count),
    postedAt: epochToIso(row.create_time ?? row.createTime),
  };
}

function readVideoId(row: Record<string, unknown>, url: string | null): string | null {
  const direct = firstString(row.aweme_id, row.awemeId, row.id, row.video_id);
  if (direct !== null && /^\d+$/.test(direct)) return direct;
  if (url === null) return null;
  return parseCanonicalTikTokUrl(url)?.videoId ?? null;
}

/**
 * Detects a failed row.
 *
 * This Actor documents no error shape, but does warn that **you are charged
 * even when the URL is 404 Not Found** — so failure rows are both real and
 * billed, and mistaking one for a success is not free. Three signals are
 * checked, in descending order of confidence:
 *
 *  1. `status_code` — TikTok's mobile API marks success with `0`, so any other
 *     value is an upstream refusal even when a `statistics` block is present.
 *  2. The generic Apify error spellings.
 *  3. Structural emptiness: no id and no `statistics` at all. Without this a
 *     404 row would fall through as a *successful* row whose metrics all happen
 *     to be null, inflating this Actor's success count and turning a source
 *     failure into a fake "returned nothing for this metric".
 */
function readErrorMessage(row: Record<string, unknown>, videoId: string | null): string | null {
  const statusCode = count(row.status_code, row.statusCode);
  if (statusCode !== null && statusCode !== 0) {
    const detail = firstString(row.status_msg, row.statusMsg);
    return detail === null ? `status_code ${statusCode}` : `status_code ${statusCode}: ${detail}`;
  }

  const code = firstString(row.errorCode, row.error_code);
  const message = firstString(row.error, row.errorMessage, row.errorDescription);
  if (code !== null) return message === null ? code : `${code}: ${message}`;
  if (message !== null) return message;
  if (row.error === true) return 'the Actor flagged this row as an error without a message';

  if (videoId === null && !isRecord(row.statistics)) {
    return 'dataset row carried neither a video id nor a statistics block';
  }
  return null;
}
