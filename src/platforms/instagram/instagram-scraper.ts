import { ScrapeError } from '../../core/models/errors.js';
import { type Platform } from '../../core/models/platform.js';
import {
  scrapeFailure,
  scrapeSuccess,
  type AcquisitionMetadata,
  type ScrapeResult,
} from '../../core/models/scrape-result.js';
import { type ScrapedVideoData } from '../../core/models/snapshot.js';
import { type FailureStatus } from '../../core/models/status.js';
import { type HttpResponse } from '../../core/scraper/http-port.js';
import { type ScrapeContext } from '../../core/scraper/scrape-context.js';
import { type Scraper } from '../../core/scraper/scraper.js';

import { parseInstagramClipsResponse } from './instagram-clips-parser.js';
import { parseInstagramMediaInfoResponse } from './instagram-media-info-parser.js';
import { InstagramParseError } from './instagram-parser-utils.js';
import { parseInstagramPostResponse, type InstagramPostData } from './instagram-post-parser.js';
import { parseCanonicalInstagramUrl } from './instagram-url-normalizer.js';

const GRAPHQL_URL = 'https://www.instagram.com/graphql/query';
const ROOT_URL = 'https://www.instagram.com/';
const WEB_APP_ID = '936619743392459';
const MOBILE_APP_ID = '124024574287414';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

export interface InstagramScraperOptions {
  postDocId?: string | undefined;
  clipsDocId?: string | undefined;
  clipsMaxPages?: number | undefined;
  clipsMaxAuthors?: number | undefined;
}

interface AnonymousState {
  csrf: string;
  cookie: string;
}

interface AttemptState {
  httpRequests: number;
  sessionUsed: boolean;
}

/** Hybrid Instagram acquisition: anonymous first, authenticated media-info fallback. */
export class InstagramScraper implements Scraper {
  readonly platform: Platform = 'instagram';
  private readonly postDocId: string;
  private readonly clipsDocId: string;
  private readonly clipsMaxPages: number;
  private readonly clipsMaxAuthors: number;
  private readonly anonymousStates = new Map<string, Promise<AnonymousState>>();

  constructor(options: InstagramScraperOptions = {}) {
    this.postDocId = options.postDocId ?? '27128499623469141';
    this.clipsDocId = options.clipsDocId ?? '27234427476213202';
    this.clipsMaxPages = options.clipsMaxPages ?? 2;
    this.clipsMaxAuthors = options.clipsMaxAuthors ?? 3;
  }

  async scrape(url: string, context: ScrapeContext): Promise<ScrapeResult> {
    const canonical = parseCanonicalInstagramUrl(url);
    if (canonical === null) {
      return scrapeFailure('error', {
        code: 'invalid_url',
        message: 'Instagram scraper requires a normalized /reel/, /p/, or /tv/ post URL',
        retryable: false,
      });
    }

    const state: AttemptState = { httpRequests: 0, sessionUsed: false };
    const partial: Partial<ScrapedVideoData> = { video_id: canonical.mediaId };
    context.logger.debug(
      { shortcode: canonical.shortcode, video_id: canonical.mediaId, attempt: context.attempt },
      'fetching Instagram post metadata',
    );

    let post: InstagramPostData;
    try {
      const anonymous = await this.anonymousState(context, state);
      const response = await this.postQuery(canonical.shortcode, anonymous, context, state);
      const failure = httpFailure(response, partial, metadata(state), 'post metadata');
      if (failure !== null) return await this.fallbackOrFailure(canonical, context, state, failure);
      post = parseInstagramPostResponse(response.body, canonical.shortcode, canonical.mediaId);
    } catch (error) {
      const failure = parseOrThrownFailure(error, partial, metadata(state));
      return await this.fallbackOrFailure(canonical, context, state, failure);
    }

    const recovered: ScrapedVideoData = stripInternal(post);
    if (post.mediaType !== 2) {
      return scrapeFailure(
        'error',
        {
          code: 'invalid_url',
          message: `Instagram media type ${post.mediaType} is not a standalone video`,
          retryable: false,
        },
        recovered,
        metadata(state),
      );
    }
    if (post.views !== null) return scrapeSuccess(recovered, metadata(state));

    let anonymousFailure: ScrapeResult | null = null;
    try {
      const anonymous = await this.anonymousState(context, state);
      for (const authorId of post.authorIds.slice(0, this.clipsMaxAuthors)) {
        let cursor: string | null = null;
        for (let pageNumber = 1; pageNumber <= this.clipsMaxPages; pageNumber += 1) {
          const response = await this.clipsQuery(authorId, cursor, anonymous, context, state);
          const failure = httpFailure(response, recovered, metadata(state), 'clips lookup');
          if (failure !== null) {
            anonymousFailure = failure;
            break;
          }
          const page = parseInstagramClipsResponse(response.body, canonical.shortcode);
          if (page.views !== null) {
            return scrapeSuccess({ ...recovered, views: page.views }, metadata(state));
          }
          if (!page.hasNextPage || page.endCursor === null) break;
          cursor = page.endCursor;
        }
        if (anonymousFailure !== null) break;
      }
    } catch (error) {
      anonymousFailure = parseOrThrownFailure(error, recovered, metadata(state));
      context.logger.debug(
        { message: error instanceof Error ? error.message : String(error) },
        'anonymous Instagram clips lookup failed; trying session fallback',
      );
    }

    if (canUseSession(context)) {
      return await this.authenticatedFallback(canonical, context, state, recovered);
    }
    if (anonymousFailure !== null) return anonymousFailure;

    return scrapeFailure(
      'error',
      {
        code: 'session_error',
        message:
          'exact Instagram views were not available anonymously; configure a proxy-bound Instagram session',
        retryable: false,
      },
      recovered,
      metadata(state),
    );
  }

  private async fallbackOrFailure(
    canonical: NonNullable<ReturnType<typeof parseCanonicalInstagramUrl>>,
    context: ScrapeContext,
    state: AttemptState,
    failure: ScrapeResult,
  ): Promise<ScrapeResult> {
    if (canUseSession(context)) {
      return await this.authenticatedFallback(canonical, context, state, failurePartial(failure));
    }
    return failure;
  }

  private async authenticatedFallback(
    canonical: NonNullable<ReturnType<typeof parseCanonicalInstagramUrl>>,
    context: ScrapeContext,
    state: AttemptState,
    partial: Partial<ScrapedVideoData>,
  ): Promise<ScrapeResult> {
    const lease = context.session;
    if (lease === null) throw new Error('session invariant violated');
    state.sessionUsed = true;
    const userAgent = lease.session.userAgent ?? DEFAULT_USER_AGENT;
    let response: HttpResponse;
    try {
      state.httpRequests += 1;
      response = await context.http.request({
        url: `https://i.instagram.com/api/v1/media/${canonical.mediaId}/info/`,
        method: 'GET',
        headers: {
          accept: '*/*',
          'accept-language': 'en-US,en;q=0.8',
          'user-agent': userAgent,
          'x-ig-app-id': MOBILE_APP_ID,
          'x-ig-www-claim': '0',
          ...lease.session.headers,
        },
        cookie: lease.session.cookie,
        proxy: context.proxy?.target ?? null,
        redirect: 'manual',
        signal: context.signal,
      });
    } catch (error) {
      return parseOrThrownFailure(error, partial, metadata(state));
    }
    const failure = httpFailure(response, partial, metadata(state), 'authenticated media-info');
    if (failure !== null) return failure;
    if (looksBlocked(response.body)) {
      return scrapeFailure(
        'rate_limited',
        {
          code: 'blocked',
          message: 'Instagram challenged or invalidated the session',
          retryable: true,
        },
        partial,
        metadata(state),
      );
    }
    try {
      return scrapeSuccess(
        parseInstagramMediaInfoResponse(response.body, canonical.shortcode, canonical.mediaId),
        metadata(state),
      );
    } catch (error) {
      return parseOrThrownFailure(error, partial, metadata(state));
    }
  }

  private async anonymousState(
    context: ScrapeContext,
    state: AttemptState,
  ): Promise<AnonymousState> {
    const key = context.proxy?.id ?? 'direct';
    let pending = this.anonymousStates.get(key);
    if (pending === undefined) {
      pending = this.bootstrapAnonymous(context, state);
      this.anonymousStates.set(key, pending);
      void pending.catch(() => this.anonymousStates.delete(key));
    }
    return await pending;
  }

  private async bootstrapAnonymous(
    context: ScrapeContext,
    state: AttemptState,
  ): Promise<AnonymousState> {
    state.httpRequests += 1;
    const response = await context.http.request({
      url: ROOT_URL,
      method: 'GET',
      headers: { 'accept-language': 'en-US,en;q=0.8', 'user-agent': DEFAULT_USER_AGENT },
      proxy: context.proxy?.target ?? null,
      redirect: 'follow',
      signal: context.signal,
    });
    if (response.status === 429 || response.status === 403) {
      throw new ScrapeError({ code: 'rate_limited', message: 'Instagram blocked CSRF bootstrap' });
    }
    if (response.status === 451) {
      throw new ScrapeError({
        code: 'geo_blocked',
        message: "Instagram is unavailable from this exit node's region",
      });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ScrapeError({
        code: 'http_error',
        message: `Instagram CSRF bootstrap returned HTTP ${response.status}`,
        retryable: response.status >= 500,
      });
    }
    const setCookie = response.headers['set-cookie'] ?? '';
    const csrf =
      /(?:^|[,;]\s*)csrftoken=([^;,]+)/i.exec(setCookie)?.[1] ??
      /["']csrf_token["']\s*:\s*["']([^"']+)/i.exec(response.body)?.[1];
    if (csrf === undefined || csrf.length === 0) {
      throw new InstagramParseError('Instagram did not issue an anonymous CSRF cookie');
    }
    return { csrf, cookie: cookieHeader(setCookie, csrf) };
  }

  private async postQuery(
    shortcode: string,
    anonymous: AnonymousState,
    context: ScrapeContext,
    state: AttemptState,
  ): Promise<HttpResponse> {
    const variables = JSON.stringify({
      shortcode,
      __relay_internal__pv__PolarisAIGMMediaWebLabelEnabledrelayprovider: false,
    });
    return await this.graphqlRequest(
      new URLSearchParams({ variables, doc_id: this.postDocId, server_timestamps: 'true' }),
      `https://www.instagram.com/reel/${shortcode}/`,
      anonymous,
      context,
      state,
    );
  }

  private async clipsQuery(
    authorId: string,
    cursor: string | null,
    anonymous: AnonymousState,
    context: ScrapeContext,
    state: AttemptState,
  ): Promise<HttpResponse> {
    const key = `instagram:clips:${context.proxy?.id ?? 'direct'}:${authorId}:${cursor ?? 'first'}`;
    const existing = context.runCache.get(key) as Promise<HttpResponse> | undefined;
    if (existing !== undefined) return await existing;
    const data: Record<string, string | number | boolean> = {
      include_feed_video: true,
      page_size: 12,
      target_user_id: authorId,
    };
    if (cursor !== null) data.max_id = cursor;
    const variables = JSON.stringify({ data });
    const request = this.graphqlRequest(
      new URLSearchParams({ variables, doc_id: this.clipsDocId, server_timestamps: 'true' }),
      'https://www.instagram.com/',
      anonymous,
      context,
      state,
    )
      .then((response) => {
        if (response.status < 200 || response.status >= 300) context.runCache.delete(key);
        return response;
      })
      .catch((error: unknown) => {
        context.runCache.delete(key);
        throw error;
      });
    context.runCache.set(key, request);
    try {
      return await request;
    } catch (error) {
      context.runCache.delete(key);
      throw error;
    }
  }

  private async graphqlRequest(
    body: URLSearchParams,
    referer: string,
    anonymous: AnonymousState,
    context: ScrapeContext,
    state: AttemptState,
  ): Promise<HttpResponse> {
    state.httpRequests += 1;
    return await context.http.request({
      url: GRAPHQL_URL,
      method: 'POST',
      headers: {
        accept: '*/*',
        'accept-language': 'en-US,en;q=0.8',
        'content-type': 'application/x-www-form-urlencoded',
        origin: ROOT_URL.slice(0, -1),
        referer,
        'user-agent': DEFAULT_USER_AGENT,
        'x-csrftoken': anonymous.csrf,
        'x-ig-app-id': WEB_APP_ID,
        'x-requested-with': 'XMLHttpRequest',
      },
      body: body.toString(),
      cookie: anonymous.cookie,
      proxy: context.proxy?.target ?? null,
      redirect: 'manual',
      signal: context.signal,
    });
  }
}

function stripInternal(post: InstagramPostData): ScrapedVideoData {
  const { shortcode: _shortcode, authorIds: _authorIds, mediaType: _mediaType, ...data } = post;
  return data;
}

function canUseSession(context: ScrapeContext): boolean {
  const session = context.session?.session;
  if (session === undefined) return false;
  return session.proxyId === (context.proxy?.id ?? null);
}

function metadata(state: AttemptState): AcquisitionMetadata {
  return { httpRequests: state.httpRequests, sessionUsed: state.sessionUsed };
}

function failurePartial(result: ScrapeResult): Partial<ScrapedVideoData> {
  return result.outcome === 'failure' ? (result.partial ?? {}) : result.data;
}

function httpFailure(
  response: HttpResponse,
  partial: Partial<ScrapedVideoData>,
  acquisition: AcquisitionMetadata,
  operation: string,
): ScrapeResult | null {
  if (response.status === 404) {
    return scrapeFailure(
      'not_found',
      { code: 'not_found', message: 'Instagram post was not found', retryable: false },
      partial,
      acquisition,
    );
  }
  if (response.status === 401 || response.status === 429) {
    return scrapeFailure(
      'rate_limited',
      { code: 'rate_limited', message: `Instagram ${operation} was rate limited`, retryable: true },
      partial,
      acquisition,
    );
  }
  if (response.status === 403) {
    return scrapeFailure(
      'rate_limited',
      { code: 'blocked', message: `Instagram blocked ${operation}`, retryable: true },
      partial,
      acquisition,
    );
  }
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.location ?? '';
    const isLogin = location.includes('/accounts/login');
    return scrapeFailure(
      isLogin ? 'private' : 'error',
      {
        code: isLogin ? 'private' : 'http_error',
        message: isLogin ? 'Instagram post requires login' : `Instagram ${operation} redirected`,
        retryable: !isLogin,
      },
      partial,
      acquisition,
    );
  }
  if (response.status === 451) {
    // A statement about where the request came from, not about the post: this
    // exit node's jurisdiction blocks it. Reported separately so the pool can
    // retire the proxy, and retried because the next attempt leases another.
    return scrapeFailure(
      'error',
      {
        code: 'geo_blocked',
        message: `Instagram ${operation} is unavailable from this exit node's region`,
        retryable: true,
      },
      partial,
      acquisition,
    );
  }
  if (response.status < 200 || response.status >= 300) {
    return scrapeFailure(
      'error',
      {
        code: 'http_error',
        message: `Instagram ${operation} returned HTTP ${response.status}`,
        retryable: response.status >= 500 || response.status === 408,
      },
      partial,
      acquisition,
    );
  }
  return null;
}

function parseOrThrownFailure(
  error: unknown,
  partial: Partial<ScrapedVideoData>,
  acquisition: AcquisitionMetadata,
): ScrapeResult {
  if (error instanceof InstagramParseError) {
    return scrapeFailure(
      'error',
      { code: 'parse_error', message: error.message, retryable: false },
      partial,
      acquisition,
    );
  }
  const scrapeError = ScrapeError.from(error);
  const status: FailureStatus = scrapeError.status === 'ok' ? 'error' : scrapeError.status;
  return scrapeFailure(status, scrapeError.toInfo(), partial, acquisition);
}

function looksBlocked(body: string): boolean {
  const lower = body.toLowerCase();
  return [
    'login_required',
    'feedback_required',
    'challenge_required',
    'checkpoint_required',
    'please wait a few minutes',
  ].some((marker) => lower.includes(marker));
}

function cookieHeader(setCookie: string, csrf: string): string {
  const pairs = [...setCookie.matchAll(/(?:^|,\s*)([A-Za-z_][A-Za-z0-9_]*)=([^;,]*)/g)]
    .map((match) => `${match[1]}=${match[2]}`)
    .filter((pair) => !pair.toLowerCase().startsWith('expires='));
  if (!pairs.some((pair) => pair.toLowerCase().startsWith('csrftoken='))) {
    pairs.push(`csrftoken=${csrf}`);
  }
  return pairs.join('; ');
}
