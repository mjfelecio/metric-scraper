import { describe, expect, it, vi } from 'vitest';

import { InputPreparer, type ResolvedUrl } from '../../src/app/input-preparer.js';
import { nullLogger } from '../../src/core/logging/logger.js';
import { type InputRecord } from '../../src/core/models/input.js';
import { RetryPolicy } from '../../src/core/retry/retry-policy.js';
import { type HttpClient } from '../../src/core/scraper/http-port.js';
import { NullProxyPool } from '../../src/infrastructure/proxy/in-memory-proxy-pool.js';
import { StaticProxyProvider } from '../../src/infrastructure/proxy/static-proxy-provider.js';
import { type UrlResolver } from '../../src/core/url/resolver.js';
import { createUrlResolverRegistry } from '../../src/core/url/resolver.js';

const CANONICAL = 'https://www.tiktok.com/@creator/video/7420000000000000001';

function record(url: string, position: number, requiresResolution: boolean): InputRecord {
  return {
    raw_url: url,
    url,
    platform: 'tiktok',
    position,
    requires_resolution: requiresResolution,
  };
}

function preparer(resolver: UrlResolver, cache?: Map<string, ResolvedUrl>): InputPreparer {
  return new InputPreparer({
    resolvers: createUrlResolverRegistry([resolver]),
    http: { request: vi.fn<HttpClient['request']>() },
    proxyProvider: new StaticProxyProvider(new NullProxyPool()),
    retryPolicy: new RetryPolicy({
      maxAttempts: 3,
      initialDelayMs: 0,
      maxDelayMs: 0,
      jitter: false,
    }),
    logger: nullLogger,
    concurrency: 3,
    requestTimeoutMs: 1_000,
    ...(cache === undefined ? {} : { cache }),
  });
}

describe('InputPreparer', () => {
  it('keeps the first input after resolving and de-duplicates in original order', async () => {
    const resolver: UrlResolver = {
      platform: 'tiktok',
      resolve: vi.fn().mockResolvedValue({
        outcome: 'ok',
        url: CANONICAL,
        videoId: '7420000000000000001',
      }),
    };
    const short = 'https://vm.tiktok.com/SHORT/';
    const prepared = await preparer(resolver).prepare([
      record(short, 1, true),
      record(CANONICAL, 2, false),
    ]);

    expect(prepared.items).toHaveLength(1);
    expect(prepared.items[0]?.record.raw_url).toBe(short);
    expect(prepared.items[0]?.record.url).toBe(CANONICAL);
    expect(prepared.issues).toEqual([
      expect.objectContaining({ code: 'duplicate_url', position: 2 }),
    ]);
  });

  it('keeps an unresolved link as a runnable failure record', async () => {
    const resolver: UrlResolver = {
      platform: 'tiktok',
      resolve: vi.fn().mockResolvedValue({
        outcome: 'failure',
        status: 'not_found',
        error: { code: 'not_found', message: 'gone', retryable: false },
      }),
    };
    const prepared = await preparer(resolver).prepare([
      record('https://vm.tiktok.com/GONE/', 1, true),
    ]);
    expect(prepared.items[0]).toMatchObject({
      kind: 'failure',
      status: 'not_found',
      error: { code: 'not_found' },
    });
    expect(prepared.issues).toHaveLength(0);
  });

  it('retries transient failures and caches only successful resolutions', async () => {
    const resolve = vi
      .fn<UrlResolver['resolve']>()
      .mockResolvedValueOnce({
        outcome: 'failure',
        status: 'rate_limited',
        error: { code: 'rate_limited', message: 'slow down', retryable: true },
      })
      .mockResolvedValueOnce({
        outcome: 'ok',
        url: CANONICAL,
        videoId: '7420000000000000001',
      });
    const cache = new Map<string, ResolvedUrl>();
    const input = record('https://vm.tiktok.com/RETRY/', 1, true);
    const instance = preparer({ platform: 'tiktok', resolve }, cache);

    const first = await instance.prepare([input]);
    const second = await instance.prepare([input]);

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(first.items[0]).toMatchObject({
      kind: 'ready',
      resolution: { attempts: 2, retries: 1 },
    });
    expect(second.items[0]).toMatchObject({ kind: 'ready', resolution: null });
  });
});
