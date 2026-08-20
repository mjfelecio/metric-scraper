import { ScrapeError } from '../../core/models/errors.js';
import { type Platform } from '../../core/models/platform.js';
import { type HttpResponse } from '../../core/scraper/http-port.js';
import {
  type UrlResolutionContext,
  type UrlResolutionResult,
  type UrlResolver,
} from '../../core/url/resolver.js';

import { InstagramUrlNormalizer } from './instagram-url-normalizer.js';

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ALLOWED_DOMAINS = ['instagram.com', 'instagr.am'] as const;
// Instagram renders a JavaScript shell for full browser user agents instead of
// issuing the redirect. A small service identity receives the actual 301/302.
const USER_AGENT = 'metric-scraper/0.1';

/** Expands Instagram share wrappers and the legacy instagr.am domain. */
export class InstagramUrlResolver implements UrlResolver {
  readonly platform: Platform = 'instagram';
  private readonly normalizer = new InstagramUrlNormalizer();

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
        return invalidDestination('Instagram short link did not redirect to a canonical post URL');
      }
      if (redirects === MAX_REDIRECTS) {
        return invalidDestination(`Instagram short link exceeded ${MAX_REDIRECTS} redirects`);
      }

      const location = response.headers.location;
      if (location === undefined || location.trim() === '') {
        return invalidDestination('Instagram redirect did not include a Location header');
      }

      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return invalidDestination('Instagram redirect returned an invalid Location header');
      }
      if (!ALLOWED_DOMAINS.some((domain) => hostMatches(next.hostname, domain))) {
        return invalidDestination('Instagram short link redirected outside Instagram');
      }
      current = next.toString();
    }

    return invalidDestination('Instagram short link could not be resolved');
  }
}

function failureForResponse(response: HttpResponse): UrlResolutionResult | null {
  if (REDIRECT_STATUSES.has(response.status)) return null;
  if (response.status === 404) {
    return {
      outcome: 'failure',
      status: 'not_found',
      error: { code: 'not_found', message: 'Instagram short link was not found', retryable: false },
    };
  }
  if (response.status === 403 || response.status === 429) {
    return {
      outcome: 'failure',
      status: 'rate_limited',
      error: {
        code: response.status === 403 ? 'blocked' : 'rate_limited',
        message: `Instagram returned HTTP ${response.status} while resolving the short link`,
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
        message: `Instagram returned HTTP ${response.status} while resolving the short link`,
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
        message: `Instagram returned HTTP ${response.status} while resolving the short link`,
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
