import { ScrapeError, type ScrapeErrorInfo } from '../../core/models/errors.js';
import { type Platform } from '../../core/models/platform.js';
import {
  scrapeFailure,
  scrapeSuccess,
  type ScrapeResult,
} from '../../core/models/scrape-result.js';
import { type FailureStatus } from '../../core/models/status.js';
import { type ScrapeContext } from '../../core/scraper/scrape-context.js';
import { type Scraper } from '../../core/scraper/scraper.js';

import { parseTikTokHydrationHtml, TikTokHydrationParseError } from './tiktok-hydration-parser.js';
import { parseTikTokPlayerResponse, TikTokPlayerParseError } from './tiktok-player-parser.js';
import { parseCanonicalTikTokUrl } from './tiktok-url-normalizer.js';

const ANONYMOUS_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

const EMBED_BASE_URL = 'https://www.tiktok.com/embed/v2/';
const PLAYER_ITEMS_URL = 'https://www.tiktok.com/player/api/v1/items';

/** Anonymous acquisition from TikTok's public first-party embed page. */
export class TikTokScraper implements Scraper {
  readonly platform: Platform = 'tiktok';

  async scrape(url: string, context: ScrapeContext): Promise<ScrapeResult> {
    const canonical = parseCanonicalTikTokUrl(url);
    if (canonical === null) {
      return scrapeFailure('error', {
        code: 'invalid_url',
        message:
          'TikTok scraper supports canonical /@handle/video/{numeric-id} and /@handle/photo/{numeric-id} URLs',
        retryable: false,
      });
    }

    context.logger.debug(
      { url, video_id: canonical.videoId, attempt: context.attempt },
      'fetching public TikTok embed page',
    );

    let response;
    try {
      response = await context.http.request({
        url: `${EMBED_BASE_URL}${canonical.videoId}`,
        method: 'GET',
        headers: {
          accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
          'cache-control': 'no-cache',
          pragma: 'no-cache',
          'user-agent': ANONYMOUS_USER_AGENT,
        },
        redirect: 'follow',
        proxy: context.proxy?.target ?? null,
        signal: context.signal,
      });
    } catch (error) {
      return failureFromThrown(error, canonical.videoId);
    }

    const partial = { video_id: canonical.videoId };
    if (response.status === 404) {
      return scrapeFailure(
        'not_found',
        { code: 'not_found', message: 'TikTok video was not found', retryable: false },
        partial,
      );
    }
    if (response.status === 429) {
      return scrapeFailure(
        'rate_limited',
        { code: 'rate_limited', message: 'TikTok rate limited the request', retryable: true },
        partial,
      );
    }
    if (response.status === 403) {
      return scrapeFailure(
        'rate_limited',
        { code: 'blocked', message: 'TikTok blocked the anonymous request', retryable: true },
        partial,
      );
    }
    if (response.status === 400) {
      return scrapeFailure(
        'private',
        {
          code: 'private',
          message: 'TikTok post is unavailable publicly or only visible to its creator',
          retryable: false,
        },
        partial,
      );
    }
    if (response.status === 451) {
      return scrapeFailure('error', geoBlocked(response.status), partial);
    }
    if (response.status < 200 || response.status >= 300) {
      const retryable = response.status >= 500 || response.status === 408;
      return scrapeFailure(
        'error',
        {
          code: 'http_error',
          message: `TikTok returned HTTP ${response.status} ${response.statusText}`.trim(),
          retryable,
        },
        partial,
      );
    }
    if (looksLikeChallengePage(response.body)) {
      return scrapeFailure(
        'rate_limited',
        {
          code: 'blocked',
          message: 'TikTok returned a browser verification challenge',
          retryable: true,
        },
        partial,
      );
    }

    try {
      const data = parseTikTokHydrationHtml(response.body, canonical.videoId);
      const exactResponse = await context.http.request({
        url: playerItemsUrl(canonical.videoId),
        method: 'GET',
        headers: {
          accept: 'application/json, text/plain, */*',
          'accept-language': 'en-US,en;q=0.9',
          'agw-js-conv': 'str',
          referer: `https://www.tiktok.com/player/v1/${canonical.videoId}`,
          'user-agent': ANONYMOUS_USER_AGENT,
        },
        redirect: 'follow',
        proxy: context.proxy?.target ?? null,
        signal: context.signal,
      });

      const exactFailure = failureFromHttpResponse(exactResponse, canonical.videoId);
      if (exactFailure !== null) return exactFailure;

      const exact = parseTikTokPlayerResponse(exactResponse.body, canonical.videoId);
      return scrapeSuccess({ ...data, ...exact });
    } catch (error) {
      if (error instanceof TikTokHydrationParseError || error instanceof TikTokPlayerParseError) {
        return scrapeFailure(
          'error',
          { code: 'parse_error', message: error.message, retryable: false },
          partial,
        );
      }
      return failureFromThrown(error, canonical.videoId);
    }
  }
}

function playerItemsUrl(videoId: string): string {
  const url = new URL(PLAYER_ITEMS_URL);
  url.searchParams.set('item_ids', videoId);
  url.searchParams.set('language', 'en-US');
  return url.toString();
}

function failureFromHttpResponse(
  response: { status: number; statusText: string },
  videoId: string,
): ScrapeResult | null {
  const partial = { video_id: videoId };
  if (response.status === 404) {
    return scrapeFailure(
      'not_found',
      { code: 'not_found', message: 'TikTok video was not found', retryable: false },
      partial,
    );
  }
  if (response.status === 429) {
    return scrapeFailure(
      'rate_limited',
      { code: 'rate_limited', message: 'TikTok rate limited the request', retryable: true },
      partial,
    );
  }
  if (response.status === 403) {
    return scrapeFailure(
      'rate_limited',
      { code: 'blocked', message: 'TikTok blocked the anonymous request', retryable: true },
      partial,
    );
  }
  if (response.status === 451) {
    return scrapeFailure('error', geoBlocked(response.status), partial);
  }
  if (response.status < 200 || response.status >= 300) {
    const retryable = response.status >= 500 || response.status === 408;
    return scrapeFailure(
      'error',
      {
        code: 'http_error',
        message: `TikTok returned HTTP ${response.status} ${response.statusText}`.trim(),
        retryable,
      },
      partial,
    );
  }
  return null;
}

/**
 * HTTP 451 is a statement about where the request came *from*, not about the
 * video: the exit node sits in a jurisdiction that blocks it. Retrying is
 * worthwhile because every attempt leases a different proxy, and the pool
 * needs this reported separately so the offending exit node can be retired.
 */
function geoBlocked(status: number): ScrapeErrorInfo {
  return {
    code: 'geo_blocked',
    message: `TikTok returned HTTP ${status} for this exit node's region`,
    retryable: true,
  };
}

function looksLikeChallengePage(body: string): boolean {
  const lower = body.toLowerCase();
  return [
    'verifycenter',
    'slardarwaf',
    '_wafchallengeid',
    'waforiginalreid',
    'captcha-verify-container',
    'captcha_verify_container',
    'id="captcha-verify-image"',
    "id='captcha-verify-image'",
  ].some((marker) => lower.includes(marker));
}

function failureFromThrown(error: unknown, videoId: string): ScrapeResult {
  const scrapeError = ScrapeError.from(error);
  const status: FailureStatus = scrapeError.status === 'ok' ? 'error' : scrapeError.status;
  return scrapeFailure(status, scrapeError.toInfo(), { video_id: videoId });
}
