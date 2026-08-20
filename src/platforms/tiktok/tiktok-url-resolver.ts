import { ScrapeError } from '../../core/models/errors.js';
import { type Platform } from '../../core/models/platform.js';
import { type HttpResponse } from '../../core/scraper/http-port.js';
import {
  type UrlResolutionContext,
  type UrlResolutionResult,
  type UrlResolver,
} from '../../core/url/resolver.js';

import { TikTokUrlNormalizer } from './tiktok-url-normalizer.js';

const TIKTOK_DOMAIN = 'tiktok.com';
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

export class TikTokUrlResolver implements UrlResolver {
  readonly platform: Platform = 'tiktok';
  private readonly normalizer = new TikTokUrlNormalizer();

  async resolve(raw: string, context: UrlResolutionContext): Promise<UrlResolutionResult> {
    let current = raw;

    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const canonical = this.normalizer.normalize(current);
      if (canonical.ok && !canonical.requiresResolution && canonical.videoId !== null) {
        return { outcome: 'ok', url: canonical.url, videoId: canonical.videoId };
      }

      let response: HttpResponse;
      try {
        response = await context.http.request({
          url: current,
          method: 'GET',
          headers: {
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'en-US,en;q=0.9',
            'user-agent': USER_AGENT,
          },
          redirect: 'manual',
          proxy: context.proxy,
          signal: context.signal,
        });
      } catch (error) {
        const scrapeError = ScrapeError.from(error);
        return {
          outcome: 'failure',
          status: scrapeError.status === 'ok' ? 'error' : scrapeError.status,
          error: scrapeError.toInfo(),
        };
      }

      const failure = failureForResponse(response);
      if (failure !== null) return failure;

      if (!REDIRECT_STATUSES.has(response.status)) {
        return invalidDestination('TikTok short link did not redirect to a canonical post URL');
      }
      if (redirects === MAX_REDIRECTS) {
        return invalidDestination(`TikTok short link exceeded ${MAX_REDIRECTS} redirects`);
      }

      const location = response.headers.location;
      if (location === undefined || location.trim() === '') {
        return invalidDestination('TikTok redirect did not include a Location header');
      }

      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return invalidDestination('TikTok redirect returned an invalid Location header');
      }
      if (!hostMatches(next.hostname, TIKTOK_DOMAIN)) {
        return invalidDestination(`TikTok short link redirected outside tiktok.com`);
      }
      current = next.toString();
    }

    return invalidDestination('TikTok short link could not be resolved');
  }
}

function failureForResponse(response: HttpResponse): UrlResolutionResult | null {
  if (REDIRECT_STATUSES.has(response.status)) return null;
  if (response.status === 404) {
    return {
      outcome: 'failure',
      status: 'not_found',
      error: { code: 'not_found', message: 'TikTok short link was not found', retryable: false },
    };
  }
  if (response.status === 403 || response.status === 429) {
    return {
      outcome: 'failure',
      status: 'rate_limited',
      error: {
        code: response.status === 403 ? 'blocked' : 'rate_limited',
        message: `TikTok returned HTTP ${response.status} while resolving the short link`,
        retryable: true,
      },
    };
  }
  if (response.status === 451) {
    return {
      outcome: 'failure',
      status: 'error',
      error: {
        code: 'geo_blocked',
        message: 'TikTok short-link resolution is unavailable from this exit node region',
        retryable: true,
      },
    };
  }
  if (response.status >= 500 || response.status === 408) {
    return {
      outcome: 'failure',
      status: 'error',
      error: {
        code: 'http_error',
        message: `TikTok returned HTTP ${response.status} while resolving the short link`,
        retryable: true,
      },
    };
  }
  if (response.status >= 400) {
    return {
      outcome: 'failure',
      status: 'error',
      error: {
        code: 'http_error',
        message: `TikTok returned HTTP ${response.status} while resolving the short link`,
        retryable: false,
      },
    };
  }
  return null;
}

function invalidDestination(message: string): UrlResolutionResult {
  return {
    outcome: 'failure',
    status: 'error',
    error: { code: 'invalid_url', message, retryable: false },
  };
}

function hostMatches(host: string, domain: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === domain || normalized.endsWith(`.${domain}`);
}
