import { describe, expect, it, vi } from 'vitest';

import { nullLogger } from '../../src/core/logging/logger.js';
import { type HttpClient, type HttpResponse } from '../../src/core/scraper/http-port.js';
import { type PlatformSession } from '../../src/core/scraper/lease-ports.js';
import { type ScrapeContext } from '../../src/core/scraper/scrape-context.js';
import { InstagramScraper } from '../../src/platforms/instagram/instagram-scraper.js';
import { shortcodeToMediaId } from '../../src/platforms/instagram/instagram-shortcode.js';

const CODE = 'DcBr7X4SL3h';
const MEDIA_ID = shortcodeToMediaId(CODE);
const URL = `https://www.instagram.com/reel/${CODE}/`;

function response(status: number, body = '', headers: Record<string, string> = {}): HttpResponse {
  return {
    url: URL,
    status,
    statusText: '',
    headers,
    body,
    redirected: false,
    durationMs: 1,
  };
}

function rootResponse(): HttpResponse {
  return response(200, '<html></html>', {
    'set-cookie': 'csrftoken=csrf-test; Path=/; Secure, mid=mid-test; Path=/; Secure',
  });
}

function rootResponseWithHtmlCsrf(): HttpResponse {
  return response(200, '<script>{"csrf_token":"html-csrf-token"}</script>', {
    'set-cookie': 'mid=mid-test; Path=/; Secure',
  });
}

function postBody(
  options: { views?: number | null; mediaType?: number; coauthorIds?: string[] } = {},
): string {
  return JSON.stringify({
    data: {
      xdt_api__v1__media__shortcode__web_info: {
        items: [
          {
            code: CODE,
            pk: MEDIA_ID,
            media_type: options.mediaType ?? 2,
            play_count: options.views ?? null,
            view_count: null,
            like_count: 920205,
            comment_count: 18567,
            taken_at: 1_700_000_000,
            user: { pk: '25025320', username: 'instagram' },
            coauthor_producers: options.coauthorIds?.map((pk) => ({ pk })),
          },
        ],
      },
    },
    status: 'ok',
  });
}

function clipsBody(
  views: number | null,
  pageInfo: { endCursor: string | null; hasNextPage: boolean } | null = null,
): string {
  return JSON.stringify({
    data: {
      xdt_api__v1__clips__user__connection_v2: {
        edges: views === null ? [] : [{ node: { media: { code: CODE, play_count: views } } }],
        page_info:
          pageInfo === null
            ? null
            : {
                end_cursor: pageInfo.endCursor,
                has_next_page: pageInfo.hasNextPage,
              },
      },
    },
    status: 'ok',
  });
}

function mediaInfoBody(): string {
  return JSON.stringify({
    items: [
      {
        code: CODE,
        play_count: 96047130,
        like_count: 920205,
        comment_count: 18567,
        taken_at: 1_700_000_000,
        user: { username: 'instagram' },
      },
    ],
    status: 'ok',
  });
}

function context(http: HttpClient, session: PlatformSession | null = null): ScrapeContext {
  return {
    attempt: 1,
    maxAttempts: 3,
    signal: new AbortController().signal,
    http,
    proxy: null,
    session: session === null ? null : { id: session.id, session },
    logger: nullLogger,
    now: () => new Date('2026-08-17T00:00:00.000Z'),
  };
}

const directSession: PlatformSession = {
  id: 'instagram-test',
  platform: 'instagram',
  proxyId: null,
  cookie: 'sessionid=test-session; csrftoken=auth-csrf',
  userAgent: null,
  headers: {},
};

describe('InstagramScraper', () => {
  it('uses anonymous post metadata when it already contains exact views', async () => {
    const request = vi
      .fn<HttpClient['request']>()
      .mockResolvedValueOnce(rootResponse())
      .mockResolvedValueOnce(response(200, postBody({ views: 123456 })));

    const result = await new InstagramScraper().scrape(URL, context({ request }));

    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') {
      expect(result.data).toMatchObject({
        video_id: MEDIA_ID,
        views: 123456,
        likes: 920205,
        comments: 18567,
        author_handle: 'instagram',
      });
      expect(result.acquisition).toEqual({ httpRequests: 2, sessionUsed: false });
    }
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('uses the homepage CSRF token when Instagram omits the csrftoken cookie', async () => {
    const request = vi
      .fn<HttpClient['request']>()
      .mockResolvedValueOnce(rootResponseWithHtmlCsrf())
      .mockResolvedValueOnce(response(200, postBody({ views: 123456 })));

    const result = await new InstagramScraper().scrape(URL, context({ request }));

    expect(result.outcome).toBe('ok');
    expect(request.mock.calls[1]?.[0].headers?.['x-csrftoken']).toBe('html-csrf-token');
    expect(request.mock.calls[1]?.[0].cookie).toContain('csrftoken=html-csrf-token');
  });

  it('looks up exact recent-Reel views through the anonymous clips operation', async () => {
    const request = vi
      .fn<HttpClient['request']>()
      .mockResolvedValueOnce(rootResponse())
      .mockResolvedValueOnce(response(200, postBody()))
      .mockResolvedValueOnce(response(200, clipsBody(96047130)));

    const result = await new InstagramScraper().scrape(URL, context({ request }));

    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') expect(result.data.views).toBe(96047130);
    const postRequest = request.mock.calls[1]?.[0];
    expect(postRequest?.method).toBe('POST');
    expect(postRequest?.cookie).toContain('csrftoken=csrf-test');
    expect(postRequest?.body).toContain('doc_id=27128499623469141');
    expect(request.mock.calls[2]?.[0].body).toContain('doc_id=27234427476213202');
  });

  it('uses max_id to find exact views on a bounded second anonymous clips page', async () => {
    const request = vi
      .fn<HttpClient['request']>()
      .mockResolvedValueOnce(rootResponse())
      .mockResolvedValueOnce(response(200, postBody()))
      .mockResolvedValueOnce(
        response(200, clipsBody(null, { endCursor: 'cursor-page-2', hasNextPage: true })),
      )
      .mockResolvedValueOnce(response(200, clipsBody(96047130)));

    const result = await new InstagramScraper().scrape(URL, context({ request }));

    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') {
      expect(result.data.views).toBe(96047130);
      expect(result.acquisition).toEqual({ httpRequests: 4, sessionUsed: false });
    }
    const body = request.mock.calls[3]?.[0].body;
    const variables = new URLSearchParams(body).get('variables');
    expect(variables === null ? null : JSON.parse(variables)).toEqual({
      data: {
        include_feed_video: true,
        page_size: 12,
        target_user_id: '25025320',
        max_id: 'cursor-page-2',
      },
    });
  });

  it('checks bounded public coauthor clips pages before requiring a session', async () => {
    const request = vi
      .fn<HttpClient['request']>()
      .mockResolvedValueOnce(rootResponse())
      .mockResolvedValueOnce(response(200, postBody({ coauthorIds: ['528817151'] })))
      .mockResolvedValueOnce(
        response(200, clipsBody(null, { endCursor: 'primary-page-2', hasNextPage: true })),
      )
      .mockResolvedValueOnce(response(200, clipsBody(null)))
      .mockResolvedValueOnce(
        response(200, clipsBody(null, { endCursor: 'coauthor-page-2', hasNextPage: true })),
      )
      .mockResolvedValueOnce(response(200, clipsBody(70905)));

    const result = await new InstagramScraper().scrape(URL, context({ request }));

    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') {
      expect(result.data.views).toBe(70905);
      expect(result.acquisition).toEqual({ httpRequests: 6, sessionUsed: false });
    }
    const coauthorRequest = request.mock.calls[4]?.[0].body;
    const variables = new URLSearchParams(coauthorRequest).get('variables');
    const parsedVariables =
      variables === null ? null : (JSON.parse(variables) as { data: { target_user_id: string } });
    expect(parsedVariables?.data.target_user_id).toBe('528817151');
  });

  it('uses authenticated media-info when an old Reel is absent from recent clips', async () => {
    const request = vi
      .fn<HttpClient['request']>()
      .mockResolvedValueOnce(rootResponse())
      .mockResolvedValueOnce(response(200, postBody()))
      .mockResolvedValueOnce(response(200, clipsBody(null)))
      .mockResolvedValueOnce(response(200, mediaInfoBody()));

    const result = await new InstagramScraper().scrape(URL, context({ request }, directSession));

    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') {
      expect(result.data.views).toBe(96047130);
      expect(result.acquisition?.sessionUsed).toBe(true);
    }
    const authenticated = request.mock.calls[3]?.[0];
    expect(authenticated?.url).toBe(`https://i.instagram.com/api/v1/media/${MEDIA_ID}/info/`);
    expect(authenticated?.cookie).toContain('sessionid=test-session');
    expect(authenticated?.redirect).toBe('manual');
  });

  it('emits a failure with partial metrics when exact old-Reel views need a session', async () => {
    const request = vi
      .fn<HttpClient['request']>()
      .mockResolvedValueOnce(rootResponse())
      .mockResolvedValueOnce(response(200, postBody()))
      .mockResolvedValueOnce(response(200, clipsBody(null)));

    const result = await new InstagramScraper().scrape(URL, context({ request }));

    expect(result.outcome).toBe('failure');
    if (result.outcome === 'failure') {
      expect(result.error.code).toBe('session_error');
      expect(result.partial).toMatchObject({
        video_id: MEDIA_ID,
        views: null,
        likes: 920205,
        comments: 18567,
      });
    }
  });

  it('does not send a session bound to a different proxy identity', async () => {
    const request = vi
      .fn<HttpClient['request']>()
      .mockResolvedValueOnce(rootResponse())
      .mockResolvedValueOnce(response(200, postBody()))
      .mockResolvedValueOnce(response(200, clipsBody(null)));
    const mismatched = { ...directSession, proxyId: 'http://proxy.example:8000' };

    const result = await new InstagramScraper().scrape(URL, context({ request }, mismatched));

    expect(result.outcome).toBe('failure');
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('rejects image and carousel posts instead of fabricating video metrics', async () => {
    const request = vi
      .fn<HttpClient['request']>()
      .mockResolvedValueOnce(rootResponse())
      .mockResolvedValueOnce(response(200, postBody({ mediaType: 8 })));

    const result = await new InstagramScraper().scrape(URL, context({ request }));

    expect(result.outcome).toBe('failure');
    if (result.outcome === 'failure') {
      expect(result.error.code).toBe('invalid_url');
      expect(result.error.retryable).toBe(false);
    }
  });

  it('maps anonymous throttling to a retryable rate-limited row', async () => {
    const request = vi
      .fn<HttpClient['request']>()
      .mockResolvedValueOnce(rootResponse())
      .mockResolvedValueOnce(response(429));

    const result = await new InstagramScraper().scrape(URL, context({ request }));

    expect(result.outcome).toBe('failure');
    if (result.outcome === 'failure') {
      expect(result.status).toBe('rate_limited');
      expect(result.error.retryable).toBe(true);
      expect(result.partial?.video_id).toBe(MEDIA_ID);
    }
  });

  it('preserves a clips HTTP failure instead of mislabeling it as a session requirement', async () => {
    const request = vi
      .fn<HttpClient['request']>()
      .mockResolvedValueOnce(rootResponse())
      .mockResolvedValueOnce(response(200, postBody()))
      .mockResolvedValueOnce(response(429));

    const result = await new InstagramScraper().scrape(URL, context({ request }));

    expect(result.outcome).toBe('failure');
    if (result.outcome === 'failure') {
      expect(result.status).toBe('rate_limited');
      expect(result.error.code).toBe('rate_limited');
      expect(result.error.retryable).toBe(true);
    }
  });

  it('rejects noncanonical input before making network requests', async () => {
    const request = vi.fn<HttpClient['request']>();
    const result = await new InstagramScraper().scrape(
      'https://www.instagram.com/instagram/',
      context({ request }),
    );
    expect(result.outcome).toBe('failure');
    expect(request).not.toHaveBeenCalled();
  });
});
