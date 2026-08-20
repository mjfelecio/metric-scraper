import { describe, expect, it, vi } from 'vitest';

import { nullLogger } from '../../src/core/logging/logger.js';
import { type HttpClient, type HttpResponse } from '../../src/core/scraper/http-port.js';
import { TikTokUrlResolver } from '../../src/platforms/tiktok/tiktok-url-resolver.js';

function response(status: number, location?: string): HttpResponse {
  return {
    url: 'https://vm.tiktok.com/SHORT/',
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

describe('TikTokUrlResolver', () => {
  it('follows relative and absolute TikTok redirects into one canonical URL', async () => {
    const request = vi
      .fn<HttpClient['request']>()
      .mockResolvedValueOnce(response(302, '/t/INTERMEDIATE/?utm_source=share'))
      .mockResolvedValueOnce(
        response(301, 'https://m.tiktok.com/@creator/video/7420000000000000001/?lang=en#comments'),
      );

    const result = await new TikTokUrlResolver().resolve(
      'https://vm.tiktok.com/SHORT/?share_app_id=1',
      context(request),
    );

    expect(result).toEqual({
      outcome: 'ok',
      url: 'https://www.tiktok.com/@creator/video/7420000000000000001',
      videoId: '7420000000000000001',
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[0].redirect).toBe('manual');
  });

  it('accepts photo destinations', async () => {
    const request = vi
      .fn<HttpClient['request']>()
      .mockResolvedValue(
        response(302, 'https://www.tiktok.com/@creator/photo/7420000000000000002'),
      );
    const result = await new TikTokUrlResolver().resolve(
      'https://vt.tiktok.com/SHORT/',
      context(request),
    );
    expect(result.outcome === 'ok' && result.url).toContain('/photo/7420000000000000002');
  });

  it('rejects redirects outside TikTok without requesting them', async () => {
    const request = vi
      .fn<HttpClient['request']>()
      .mockResolvedValue(response(302, 'https://example.com/video/1'));
    const result = await new TikTokUrlResolver().resolve(
      'https://vm.tiktok.com/SHORT/',
      context(request),
    );
    expect(result.outcome).toBe('failure');
    if (result.outcome === 'failure') {
      expect(result.error.code).toBe('invalid_url');
      expect(result.error.retryable).toBe(false);
    }
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rejects missing locations and redirect chains longer than five hops', async () => {
    const missing = vi.fn<HttpClient['request']>().mockResolvedValue(response(302));
    const missingResult = await new TikTokUrlResolver().resolve(
      'https://vm.tiktok.com/MISSING/',
      context(missing),
    );
    expect(missingResult.outcome === 'failure' && missingResult.error.code).toBe('invalid_url');

    const looping = vi
      .fn<HttpClient['request']>()
      .mockResolvedValue(response(302, 'https://vm.tiktok.com/LOOP/'));
    const loopResult = await new TikTokUrlResolver().resolve(
      'https://vm.tiktok.com/LOOP/',
      context(looping),
    );
    expect(loopResult.outcome === 'failure' && loopResult.error.message).toContain('exceeded 5');
    expect(looping).toHaveBeenCalledTimes(6);
  });

  it.each([
    [404, 'not_found', false],
    [403, 'blocked', true],
    [429, 'rate_limited', true],
    [451, 'geo_blocked', true],
    [503, 'http_error', true],
    [400, 'http_error', false],
  ] as const)('maps HTTP %i to %s', async (status, code, retryable) => {
    const request = vi.fn<HttpClient['request']>().mockResolvedValue(response(status));
    const result = await new TikTokUrlResolver().resolve(
      'https://vm.tiktok.com/SHORT/',
      context(request),
    );
    expect(result.outcome).toBe('failure');
    if (result.outcome === 'failure') {
      expect(result.error.code).toBe(code);
      expect(result.error.retryable).toBe(retryable);
    }
  });
});
