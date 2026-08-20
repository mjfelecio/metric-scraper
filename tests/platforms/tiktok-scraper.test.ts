import { describe, expect, it, vi } from 'vitest';

import { nullLogger } from '../../src/core/logging/logger.js';
import { HttpError, type HttpClient, type HttpResponse } from '../../src/core/scraper/http-port.js';
import { type ScrapeContext } from '../../src/core/scraper/scrape-context.js';
import { TikTokScraper } from '../../src/platforms/tiktok/tiktok-scraper.js';

const VIDEO_ID = '7420000000000000001';
const URL = `https://www.tiktok.com/@creator/video/${VIDEO_ID}`;

function validHtml(): string {
  return `<script id="__FRONTITY_CONNECT_STATE__">${JSON.stringify({
    source: {
      data: {
        [`/embed/v2/${VIDEO_ID}`]: {
          videoData: {
            itemInfos: {
              id: VIDEO_ID,
              createTime: 1_700_000_000,
              playCount: 100,
              diggCount: 20,
              commentCount: 3,
              shareCount: 4,
            },
          },
        },
      },
    },
  })}</script>`;
}

function validPlayerJson(): string {
  return JSON.stringify({
    items: [
      {
        id_str: VIDEO_ID,
        statistics_info: {
          comment_count: 5,
          digg_count: 21,
          share_count: 7,
        },
      },
    ],
  });
}

function response(status: number, body = '', statusText = ''): HttpResponse {
  return {
    url: URL,
    status,
    statusText,
    headers: { 'content-type': 'text/html' },
    body,
    redirected: false,
    durationMs: 1,
  };
}

function context(http: HttpClient): ScrapeContext {
  return {
    attempt: 1,
    maxAttempts: 3,
    signal: new AbortController().signal,
    http,
    proxy: null,
    session: null,
    logger: nullLogger,
    runCache: new Map<string, unknown>(),
    now: () => new Date('2026-08-17T00:00:00.000Z'),
  };
}

describe('TikTokScraper', () => {
  it('fetches anonymously and returns validated core metrics', async () => {
    const request = vi
      .fn<HttpClient['request']>()
      .mockResolvedValueOnce(response(200, validHtml()))
      .mockResolvedValueOnce(response(200, validPlayerJson()));
    const result = await new TikTokScraper().scrape(URL, context({ request }));

    expect(result).toEqual({
      outcome: 'ok',
      data: {
        video_id: VIDEO_ID,
        views: 100,
        likes: 21,
        comments: 5,
        shares: 7,
        saves: null,
        author_handle: null,
        author_follower_count: null,
        posted_at: '2023-11-14T22:13:20.000Z',
      },
    });
    expect(request).toHaveBeenCalledTimes(2);
    const sent = request.mock.calls[0]?.[0];
    expect(sent?.url).toBe(`https://www.tiktok.com/embed/v2/${VIDEO_ID}`);
    expect(sent?.method).toBe('GET');
    expect(sent?.redirect).toBe('follow');
    expect(sent?.cookie).toBeUndefined();
    expect(sent?.proxy).toBeNull();
    expect(sent?.headers?.['user-agent']).toContain('Mozilla/5.0');

    const exactRequest = request.mock.calls[1]?.[0];
    expect(exactRequest?.url).toBe(
      `https://www.tiktok.com/player/api/v1/items?item_ids=${VIDEO_ID}&language=en-US`,
    );
    expect(exactRequest?.headers?.['agw-js-conv']).toBe('str');
    expect(exactRequest?.cookie).toBeUndefined();
  });

  it('fails instead of silently using rounded interactions when exact metrics fail', async () => {
    const request = vi
      .fn<HttpClient['request']>()
      .mockResolvedValueOnce(response(200, validHtml()))
      .mockResolvedValueOnce(response(429));
    const result = await new TikTokScraper().scrape(URL, context({ request }));

    expect(result.outcome).toBe('failure');
    if (result.outcome === 'failure') {
      expect(result.status).toBe('rate_limited');
      expect(result.error.code).toBe('rate_limited');
      expect(result.error.retryable).toBe(true);
    }
  });

  it('rejects non-canonical URLs before making a request', async () => {
    const request = vi.fn<HttpClient['request']>();
    const result = await new TikTokScraper().scrape(
      'https://vm.tiktok.com/ABC123/',
      context({ request }),
    );

    expect(result.outcome).toBe('failure');
    if (result.outcome === 'failure') expect(result.error.code).toBe('invalid_url');
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    [404, 'not_found', 'not_found', false],
    [429, 'rate_limited', 'rate_limited', true],
    [403, 'rate_limited', 'blocked', true],
    [500, 'error', 'http_error', true],
    [400, 'private', 'private', false],
    // 451 is about the exit node's jurisdiction, not the video, so it gets its
    // own code and is worth retrying through a different proxy.
    [451, 'error', 'geo_blocked', true],
  ] as const)(
    'maps HTTP %i to %s/%s',
    async (httpStatus, expectedStatus, expectedCode, retryable) => {
      const http: HttpClient = {
        request: () => Promise.resolve(response(httpStatus, '', 'Test Status')),
      };
      const result = await new TikTokScraper().scrape(URL, context(http));

      expect(result.outcome).toBe('failure');
      if (result.outcome === 'failure') {
        expect(result.status).toBe(expectedStatus);
        expect(result.error.code).toBe(expectedCode);
        expect(result.error.retryable).toBe(retryable);
        expect(result.partial?.video_id).toBe(VIDEO_ID);
      }
    },
  );

  it('maps a verification page to a retryable blocked result', async () => {
    const http: HttpClient = {
      request: () => Promise.resolve(response(200, '<div class="verifycenter"></div>')),
    };
    const result = await new TikTokScraper().scrape(URL, context(http));

    expect(result.outcome).toBe('failure');
    if (result.outcome === 'failure') {
      expect(result.status).toBe('rate_limited');
      expect(result.error.code).toBe('blocked');
      expect(result.error.retryable).toBe(true);
    }
  });

  it('maps TikTok creator-only status to private instead of HTTP 400', async () => {
    const request = vi
      .fn<HttpClient['request']>()
      .mockResolvedValue(response(400, '<html>embed error</html>', 'Bad Request'));
    const http: HttpClient = {
      request,
    };

    const result = await new TikTokScraper().scrape(URL, context(http));

    expect(result.outcome).toBe('failure');
    if (result.outcome === 'failure') {
      expect(result.status).toBe('private');
      expect(result.error).toEqual({
        code: 'private',
        message: 'TikTok post is unavailable publicly or only visible to its creator',
        retryable: false,
      });
      expect(result.partial?.video_id).toBe(VIDEO_ID);
    }
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('maps TikTok Slardar WAF pages to a retryable blocked result', async () => {
    const http: HttpClient = {
      request: () =>
        Promise.resolve(response(200, '<script>SlardarWAF</script><p class="_wafchallengeid">')),
    };
    const result = await new TikTokScraper().scrape(URL, context(http));

    expect(result.outcome).toBe('failure');
    if (result.outcome === 'failure') {
      expect(result.status).toBe('rate_limited');
      expect(result.error.code).toBe('blocked');
      expect(result.error.retryable).toBe(true);
    }
  });

  it('returns a permanent parse error when hydration data is absent', async () => {
    const http: HttpClient = {
      request: () => Promise.resolve(response(200, '<html>normal shell</html>')),
    };
    const result = await new TikTokScraper().scrape(URL, context(http));

    expect(result.outcome).toBe('failure');
    if (result.outcome === 'failure') {
      expect(result.error.code).toBe('parse_error');
      expect(result.error.retryable).toBe(false);
      expect(result.partial?.video_id).toBe(VIDEO_ID);
    }
  });

  it('preserves transport retryability and the URL-derived video id', async () => {
    const http: HttpClient = {
      request: () =>
        Promise.reject(new HttpError({ code: 'network_error', message: 'connection reset' })),
    };
    const result = await new TikTokScraper().scrape(URL, context(http));

    expect(result.outcome).toBe('failure');
    if (result.outcome === 'failure') {
      expect(result.error.code).toBe('network_error');
      expect(result.error.retryable).toBe(true);
      expect(result.partial?.video_id).toBe(VIDEO_ID);
    }
  });
});
