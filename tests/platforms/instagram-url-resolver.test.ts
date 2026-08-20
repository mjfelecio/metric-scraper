import { describe, expect, it, vi } from 'vitest';

import { nullLogger } from '../../src/core/logging/logger.js';
import { type HttpClient, type HttpResponse } from '../../src/core/scraper/http-port.js';
import { InstagramUrlResolver } from '../../src/platforms/instagram/instagram-url-resolver.js';

function response(status: number, location?: string): HttpResponse {
  return {
    url: 'https://www.instagram.com/share/reel/SHORT/',
    status,
    statusText: '',
    headers: location === undefined ? {} : { location },
    body: '',
    redirected: false,
    durationMs: 1,
  };
}

function context(request: HttpClient['request']) {
  return {
    http: { request },
    proxy: null,
    signal: new AbortController().signal,
    logger: nullLogger,
  };
}

describe('InstagramUrlResolver', () => {
  it.each([
    [
      'https://www.instagram.com/share/reel/SHORT/',
      'https://www.instagram.com/reel/ABC123/?igsh=tracking',
      'https://www.instagram.com/reel/ABC123/',
    ],
    [
      'https://www.instagram.com/share/p/SHORT/',
      'https://www.instagram.com/p/ABC123/?igsh=tracking',
      'https://www.instagram.com/p/ABC123/',
    ],
    [
      'https://www.instagram.com/share/SHORT/',
      'https://www.instagram.com/p/ABC123/',
      'https://www.instagram.com/p/ABC123/',
    ],
    [
      'https://instagr.am/p/ABC123/',
      'https://www.instagram.com/p/ABC123/?short_redirect=1',
      'https://www.instagram.com/p/ABC123/',
    ],
  ] as const)('resolves %s to a canonical post URL', async (input, destination, expected) => {
    const request = vi.fn<HttpClient['request']>().mockResolvedValue(response(302, destination));

    const result = await new InstagramUrlResolver().resolve(input, context(request));

    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') {
      expect(result.url).toBe(expected);
      expect(result.videoId).toMatch(/^\d+$/);
    }
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0].redirect).toBe('manual');
    expect(request.mock.calls[0]?.[0].headers?.['user-agent']).toBe('metric-scraper/0.1');
  });

  it('follows relative Instagram redirects', async () => {
    const request = vi
      .fn<HttpClient['request']>()
      .mockResolvedValueOnce(response(302, '/share/reel/NEXT/'))
      .mockResolvedValueOnce(response(301, '/reel/ABC123/?igsh=tracking'));

    const result = await new InstagramUrlResolver().resolve(
      'https://www.instagram.com/share/reel/SHORT/',
      context(request),
    );

    expect(result.outcome === 'ok' && result.url).toBe('https://www.instagram.com/reel/ABC123/');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('rejects redirects outside Instagram without requesting them', async () => {
    const request = vi
      .fn<HttpClient['request']>()
      .mockResolvedValue(response(302, 'https://example.com/p/ABC123/'));

    const result = await new InstagramUrlResolver().resolve(
      'https://www.instagram.com/share/reel/SHORT/',
      context(request),
    );

    expect(result.outcome).toBe('failure');
    if (result.outcome === 'failure') expect(result.error.code).toBe('invalid_url');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rejects missing locations and redirect chains longer than five hops', async () => {
    const missing = vi.fn<HttpClient['request']>().mockResolvedValue(response(302));
    const missingResult = await new InstagramUrlResolver().resolve(
      'https://www.instagram.com/share/reel/MISSING/',
      context(missing),
    );
    expect(missingResult.outcome === 'failure' && missingResult.error.code).toBe('invalid_url');

    const looping = vi
      .fn<HttpClient['request']>()
      .mockResolvedValue(response(302, 'https://www.instagram.com/share/reel/LOOP/'));
    const loopResult = await new InstagramUrlResolver().resolve(
      'https://www.instagram.com/share/reel/LOOP/',
      context(looping),
    );
    expect(loopResult.outcome === 'failure' && loopResult.error.message).toContain('exceeded 5');
    expect(looping).toHaveBeenCalledTimes(6);
  });

  it.each([
    [404, 'not_found', false],
    [403, 'blocked', true],
    [429, 'rate_limited', true],
    [503, 'http_error', true],
    [400, 'http_error', false],
  ] as const)('maps HTTP %i to %s', async (status, code, retryable) => {
    const request = vi.fn<HttpClient['request']>().mockResolvedValue(response(status));
    const result = await new InstagramUrlResolver().resolve(
      'https://www.instagram.com/share/reel/SHORT/',
      context(request),
    );
    expect(result.outcome).toBe('failure');
    if (result.outcome === 'failure') {
      expect(result.error.code).toBe(code);
      expect(result.error.retryable).toBe(retryable);
    }
  });
});
