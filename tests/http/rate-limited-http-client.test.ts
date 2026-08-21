import { describe, expect, it } from 'vitest';

import { type HttpClient, type HttpRequest, type HttpResponse } from '../../src/core/scraper/http-port.js';
import { RateLimitedHttpClient } from '../../src/infrastructure/http/rate-limited-http-client.js';

function response(url: string): HttpResponse {
  return { url, status: 200, statusText: 'OK', headers: {}, body: '', redirected: false, durationMs: 0 };
}

/** Records every request it sees; never actually waits. */
function innerClient(): { client: HttpClient; seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    client: {
      request: (request: HttpRequest) => {
        seen.push(request.url);
        return Promise.resolve(response(request.url));
      },
    },
  };
}

/** Deterministic clock/sleep pair, matching the style in rate-limit.test.ts. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[] } {
  let now = 0;
  const slept: number[] = [];
  return {
    now: () => now,
    sleep: (ms) => {
      slept.push(ms);
      now += ms;
      return Promise.resolve();
    },
    slept,
  };
}

describe('RateLimitedHttpClient', () => {
  it('passes requests through unthrottled when the numeric rate is 0', async () => {
    const { client: inner, seen } = innerClient();
    const client = new RateLimitedHttpClient({ inner, rpmPerHost: 0 });

    await client.request({ url: 'https://www.tiktok.com/a' });
    await client.request({ url: 'https://www.tiktok.com/b' });

    expect(seen).toEqual(['https://www.tiktok.com/a', 'https://www.tiktok.com/b']);
  });

  it('paces a single host at the configured numeric rate', async () => {
    const { client: inner } = innerClient();
    const clock = fakeClock();
    const client = new RateLimitedHttpClient({
      inner,
      rpmPerHost: 600, // 10/s
      burst: 1,
      now: clock.now,
      sleep: clock.sleep,
    });

    await client.request({ url: 'https://www.tiktok.com/a' });
    await client.request({ url: 'https://www.tiktok.com/b' });

    expect(clock.slept).toEqual([100]);
  });

  it('gives each host its own budget', async () => {
    const { client: inner } = innerClient();
    const clock = fakeClock();
    const client = new RateLimitedHttpClient({
      inner,
      rpmPerHost: 60, // 1/s
      burst: 1,
      now: clock.now,
      sleep: clock.sleep,
    });

    await client.request({ url: 'https://www.tiktok.com/a' });
    await client.request({ url: 'https://www.instagram.com/a' });

    expect(clock.slept).toEqual([]);
  });

  it('resolves the rate per host via a function, so platforms can differ', async () => {
    const { client: inner } = innerClient();
    const clock = fakeClock();
    const rates: Record<string, number> = {
      'www.tiktok.com': 600, // 10/s, generous
      'www.instagram.com': 60, // 1/s, strict
    };
    const client = new RateLimitedHttpClient({
      inner,
      rpmPerHost: (host) => rates[host] ?? 0,
      burst: 1,
      now: clock.now,
      sleep: clock.sleep,
    });

    // TikTok stays within its generous burst-then-pace budget.
    await client.request({ url: 'https://www.tiktok.com/a' });
    await client.request({ url: 'https://www.tiktok.com/b' });
    expect(clock.slept).toEqual([100]);

    // Instagram's stricter rate makes a second immediate request wait.
    await client.request({ url: 'https://www.instagram.com/a' });
    await client.request({ url: 'https://www.instagram.com/b' });
    expect(clock.slept).toEqual([100, 1000]);
  });

  it('lets a host resolve to 0 (unlimited) while another is throttled', async () => {
    const { client: inner } = innerClient();
    const clock = fakeClock();
    const client = new RateLimitedHttpClient({
      inner,
      rpmPerHost: (host) => (host === 'www.instagram.com' ? 60 : 0),
      burst: 1,
      now: clock.now,
      sleep: clock.sleep,
    });

    await client.request({ url: 'https://www.tiktok.com/a' });
    await client.request({ url: 'https://www.tiktok.com/b' });
    await client.request({ url: 'https://www.tiktok.com/c' });
    expect(clock.slept).toEqual([]);

    await client.request({ url: 'https://www.instagram.com/a' });
    await client.request({ url: 'https://www.instagram.com/b' });
    expect(clock.slept).toEqual([1000]);
  });

  it('reports wait time through onWait only when a request actually waited', async () => {
    const { client: inner } = innerClient();
    const clock = fakeClock();
    const waits: Array<{ waitMs: number; host: string }> = [];
    const client = new RateLimitedHttpClient({
      inner,
      rpmPerHost: 60,
      burst: 1,
      now: clock.now,
      sleep: clock.sleep,
      onWait: (waitMs, host) => waits.push({ waitMs, host }),
    });

    await client.request({ url: 'https://www.instagram.com/a' });
    expect(waits).toEqual([]);

    await client.request({ url: 'https://www.instagram.com/b' });
    expect(waits).toEqual([{ waitMs: 1000, host: 'www.instagram.com' }]);
  });
});
