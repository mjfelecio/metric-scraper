import { describe, expect, it } from 'vitest';

import { TikTokScraper } from '../../../src/platforms/tiktok/tiktok-scraper.js';
import { createTikTokMockUpstream } from '../../../src/stress/upstream/tiktok-mock-upstream.js';
import { createSharedMockAgent } from '../../../src/stress/upstream/proxy-mock-dispatcher.js';
import { tiktokSyntheticUrl } from '../../../src/stress/workload/synthetic-input.js';
import { type TikTokScenario } from '../../../src/stress/workload/scenario.js';
import { type TikTokWorkloadProfile } from '../../../src/stress/workload/workload-profile.js';

import { buildStressHttpClient, stressContext } from './test-helpers.js';

const SEED = 42;

function profileFor(scenario: TikTokScenario, retryFailFirstN = 1): TikTokWorkloadProfile {
  return {
    scenarios: { [scenario]: 1 },
    retryFailFirstN,
    latency: { minMs: 0, maxMs: 0 },
    responseSize: { targetBytes: 26_000 },
  };
}

function setup(scenario: TikTokScenario, retryFailFirstN = 1) {
  const mockAgent = createSharedMockAgent();
  const profile = profileFor(scenario, retryFailFirstN);
  const upstream = createTikTokMockUpstream(profile, SEED);
  upstream.register(mockAgent);
  const { http, bandwidth } = buildStressHttpClient(mockAgent, upstream.computeLatencyMs);
  return { http, bandwidth };
}

describe('TikTok mock upstream', () => {
  it('normal: real TikTokScraper parses a full embed+player success', async () => {
    const { http, bandwidth } = setup('normal');
    const url = tiktokSyntheticUrl(1);

    const result = await new TikTokScraper().scrape(url, stressContext(http));

    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') {
      expect(result.data.views).toBeGreaterThan(0);
      expect(result.data.likes).toBeGreaterThan(0);
      expect(result.data.author_handle).toMatch(/^stressuser/);
    }
    // Realistic ~25-28KB wire size per request, per the task's observed range.
    expect(bandwidth.view().requests).toBe(2);
    expect(bandwidth.view().bytesPerRequest).toBeGreaterThan(20_000);
  });

  it.each([
    ['embed_403', 'rate_limited', 'blocked', true],
    ['embed_429', 'rate_limited', 'rate_limited', true],
    ['embed_500', 'error', 'http_error', true],
    ['embed_not_found', 'not_found', 'not_found', false],
    ['embed_challenge', 'rate_limited', 'blocked', true],
    ['embed_timeout', 'error', 'timeout', true],
  ] as const)(
    '%s maps to status %s / code %s',
    async (scenario, expectedStatus, expectedCode, retryable) => {
      const { http } = setup(scenario);
      const url = tiktokSyntheticUrl(2);

      const result = await new TikTokScraper().scrape(url, stressContext(http));

      expect(result.outcome).toBe('failure');
      if (result.outcome === 'failure') {
        expect(result.status).toBe(expectedStatus);
        expect(result.error.code).toBe(expectedCode);
        expect(result.error.retryable).toBe(retryable);
      }
    },
  );

  it.each([
    ['player_403', 'rate_limited', 'blocked'],
    ['player_429', 'rate_limited', 'rate_limited'],
    ['player_500', 'error', 'http_error'],
    ['player_timeout', 'error', 'timeout'],
  ] as const)(
    '%s: embed succeeds but player fails',
    async (scenario, expectedStatus, expectedCode) => {
      const { http } = setup(scenario);
      const url = tiktokSyntheticUrl(3);

      const result = await new TikTokScraper().scrape(url, stressContext(http));

      expect(result.outcome).toBe('failure');
      if (result.outcome === 'failure') {
        expect(result.status).toBe(expectedStatus);
        expect(result.error.code).toBe(expectedCode);
        // Views/author already came from the embed page before the player call failed.
        expect(result.partial?.video_id).toBeDefined();
      }
    },
  );

  it('retry_then_success: fails the configured number of embed attempts, then succeeds', async () => {
    const { http } = setup('retry_then_success', 2);
    const url = tiktokSyntheticUrl(4);

    const attempt1 = await new TikTokScraper().scrape(url, stressContext(http, { attempt: 1 }));
    const attempt2 = await new TikTokScraper().scrape(url, stressContext(http, { attempt: 2 }));
    const attempt3 = await new TikTokScraper().scrape(url, stressContext(http, { attempt: 3 }));

    expect(attempt1.outcome).toBe('failure');
    expect(attempt2.outcome).toBe('failure');
    expect(attempt3.outcome).toBe('ok');
  });

  it.each(['embed_403', 'embed_429', 'embed_500', 'embed_challenge', 'embed_timeout'] as const)(
    '%s: fails the first attempt but a retry (fresh proxy) recovers',
    async (scenario) => {
      const { http } = setup(scenario);
      const url = tiktokSyntheticUrl(5);

      const attempt1 = await new TikTokScraper().scrape(url, stressContext(http, { attempt: 1 }));
      const attempt2 = await new TikTokScraper().scrape(url, stressContext(http, { attempt: 2 }));

      expect(attempt1.outcome).toBe('failure');
      expect(attempt2.outcome).toBe('ok');
    },
  );

  it.each(['player_403', 'player_429', 'player_500', 'player_timeout'] as const)(
    '%s: fails the first attempt but a retry recovers',
    async (scenario) => {
      const { http } = setup(scenario);
      const url = tiktokSyntheticUrl(6);

      const attempt1 = await new TikTokScraper().scrape(url, stressContext(http, { attempt: 1 }));
      const attempt2 = await new TikTokScraper().scrape(url, stressContext(http, { attempt: 2 }));

      expect(attempt1.outcome).toBe('failure');
      expect(attempt2.outcome).toBe('ok');
    },
  );

  it('embed_not_found stays not_found even across repeated independent scrapes of the same URL', async () => {
    // Unlike a transient rate-limit, a deleted video does not "come back" --
    // this is the acceptance-criterion-5 shape (same URL scraped 3x).
    const { http } = setup('embed_not_found');
    const url = tiktokSyntheticUrl(7);

    const first = await new TikTokScraper().scrape(url, stressContext(http));
    const second = await new TikTokScraper().scrape(url, stressContext(http));
    const third = await new TikTokScraper().scrape(url, stressContext(http));

    for (const result of [first, second, third]) {
      expect(result.outcome).toBe('failure');
      if (result.outcome === 'failure') expect(result.status).toBe('not_found');
    }
  });

  it('is deterministic: the same seed and id always pick the same scenario', async () => {
    const mockAgentA = createSharedMockAgent();
    const mockAgentB = createSharedMockAgent();
    const profile = {
      scenarios: { normal: 60, embed_403: 20, embed_429: 20 },
      retryFailFirstN: 1,
      latency: { minMs: 0, maxMs: 0 },
      responseSize: { targetBytes: 5_000 },
    };
    const upstreamA = createTikTokMockUpstream(profile, SEED);
    const upstreamB = createTikTokMockUpstream(profile, SEED);
    upstreamA.register(mockAgentA);
    upstreamB.register(mockAgentB);
    const a = buildStressHttpClient(mockAgentA, upstreamA.computeLatencyMs);
    const b = buildStressHttpClient(mockAgentB, upstreamB.computeLatencyMs);

    const outcomes: [string, string][] = [];
    for (let index = 10; index < 30; index += 1) {
      const url = tiktokSyntheticUrl(index);
      const resultA = await new TikTokScraper().scrape(url, stressContext(a.http));
      const resultB = await new TikTokScraper().scrape(url, stressContext(b.http));
      outcomes.push([resultA.outcome, resultB.outcome]);
    }

    for (const [outcomeA, outcomeB] of outcomes) {
      expect(outcomeA).toBe(outcomeB);
    }
    // Not every synthetic id should land on the same scenario -- otherwise
    // this test would pass trivially even if hashing were broken.
    expect(new Set(outcomes.map(([outcomeA]) => outcomeA)).size).toBeGreaterThan(1);
  });
});
