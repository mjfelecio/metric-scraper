import { describe, expect, it } from 'vitest';

import { InstagramScraper } from '../../../src/platforms/instagram/instagram-scraper.js';
import { type PlatformSession } from '../../../src/core/scraper/lease-ports.js';
import { createInstagramMockUpstream } from '../../../src/stress/upstream/instagram-mock-upstream.js';
import { createSharedMockAgent } from '../../../src/stress/upstream/proxy-mock-dispatcher.js';
import { instagramSyntheticUrl } from '../../../src/stress/workload/synthetic-input.js';
import { type InstagramScenario } from '../../../src/stress/workload/scenario.js';
import { type InstagramWorkloadProfile } from '../../../src/stress/workload/workload-profile.js';

import { buildStressHttpClient, stressContext } from './test-helpers.js';

const SEED = 7;
const POST_DOC_ID = '27128499623469141';
const CLIPS_DOC_ID = '27234427476213202';

function profileFor(scenario: InstagramScenario): InstagramWorkloadProfile {
  return {
    scenarios: { [scenario]: 1 },
    clipsMaxPages: 2,
    clipsMaxAuthors: 3,
    latency: { minMs: 0, maxMs: 0 },
    responseSize: { targetBytes: 26_000 },
  };
}

function setup(scenario: InstagramScenario) {
  const mockAgent = createSharedMockAgent();
  const profile = profileFor(scenario);
  const docIds = { postDocId: POST_DOC_ID, clipsDocId: CLIPS_DOC_ID };
  const upstream = createInstagramMockUpstream(profile, SEED, docIds);
  upstream.register(mockAgent);
  const { http, bandwidth } = buildStressHttpClient(mockAgent, upstream.computeLatencyMs);
  return { http, bandwidth };
}

const directSession: PlatformSession = {
  id: 'stress-session',
  platform: 'instagram',
  proxyId: null,
  cookie: 'sessionid=stress; csrftoken=stress',
  userAgent: null,
  headers: {},
};

describe('Instagram mock upstream', () => {
  it('fast_path: post query alone has play_count', async () => {
    const { http, bandwidth } = setup('fast_path');
    const url = instagramSyntheticUrl(1);

    const result = await new InstagramScraper().scrape(url, stressContext(http));

    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') {
      expect(result.data.views).toBeGreaterThan(0);
      expect(result.acquisition).toEqual({ httpRequests: 2, sessionUsed: false });
    }
    expect(bandwidth.view().requests).toBe(2);
  });

  it('clips_page1: found on the first author, first clips page', async () => {
    const { http } = setup('clips_page1');
    const url = instagramSyntheticUrl(2);

    const result = await new InstagramScraper().scrape(url, stressContext(http));

    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok')
      expect(result.acquisition).toEqual({ httpRequests: 3, sessionUsed: false });
  });

  it('clips_page2: needs a second clips page for the first author', async () => {
    const { http } = setup('clips_page2');
    const url = instagramSyntheticUrl(3);

    const result = await new InstagramScraper().scrape(url, stressContext(http));

    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok')
      expect(result.acquisition).toEqual({ httpRequests: 4, sessionUsed: false });
  });

  it('clips_deep: found on a later author', async () => {
    const { http } = setup('clips_deep');
    const url = instagramSyntheticUrl(4);

    const result = await new InstagramScraper().scrape(url, stressContext(http));

    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') {
      // At least root(cached)+post+one clips call beyond the first author.
      expect(result.acquisition?.httpRequests ?? 0).toBeGreaterThanOrEqual(4);
    }
  });

  it('clips_exhausted with no session configured: session_error failure', async () => {
    const { http } = setup('clips_exhausted');
    const url = instagramSyntheticUrl(5);

    const result = await new InstagramScraper().scrape(url, stressContext(http));

    expect(result.outcome).toBe('failure');
    if (result.outcome === 'failure') expect(result.error.code).toBe('session_error');
  });

  it('clips_exhausted with a proxy-pinned session: worst-case authenticated fallback succeeds', async () => {
    const { http, bandwidth } = setup('clips_exhausted');
    const url = instagramSyntheticUrl(6);

    const result = await new InstagramScraper().scrape(
      url,
      stressContext(http, { session: { id: directSession.id, session: directSession } }),
    );

    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') expect(result.acquisition?.sessionUsed).toBe(true);
    // root(1, cached within this scraper instance) + post(1) + clips(3 authors x 2
    // pages = 6) + media-info(1) = up to 9 logical requests -- the task's
    // documented worst-case path.
    expect(bandwidth.view().requests).toBeGreaterThanOrEqual(8);
  });

  it.each([
    ['post_403', 'rate_limited', 'blocked'],
    ['post_429', 'rate_limited', 'rate_limited'],
    ['post_500', 'error', 'http_error'],
    ['post_not_found', 'not_found', 'not_found'],
    ['post_timeout', 'error', 'timeout'],
    ['post_malformed', 'error', 'parse_error'],
    ['post_missing_fields', 'error', 'parse_error'],
  ] as const)('%s maps to status %s / code %s', async (scenario, expectedStatus, expectedCode) => {
    const { http } = setup(scenario);
    const url = instagramSyntheticUrl(7);

    const result = await new InstagramScraper().scrape(url, stressContext(http));

    expect(result.outcome).toBe('failure');
    if (result.outcome === 'failure') {
      expect(result.status).toBe(expectedStatus);
      expect(result.error.code).toBe(expectedCode);
    }
  });

  it.each(['post_403', 'post_429', 'post_500', 'post_timeout'] as const)(
    '%s: fails the first post attempt but a retry (fresh proxy) recovers',
    async (scenario) => {
      const { http } = setup(scenario);
      const url = instagramSyntheticUrl(8);

      const attempt1 = await new InstagramScraper().scrape(
        url,
        stressContext(http, { attempt: 1 }),
      );
      const attempt2 = await new InstagramScraper().scrape(
        url,
        stressContext(http, { attempt: 2 }),
      );

      expect(attempt1.outcome).toBe('failure');
      expect(attempt2.outcome).toBe('ok');
    },
  );

  it.each(['post_not_found', 'post_malformed', 'post_missing_fields'] as const)(
    '%s stays permanent even across repeated independent scrapes of the same URL',
    async (scenario) => {
      const { http } = setup(scenario);
      const url = instagramSyntheticUrl(9);

      const first = await new InstagramScraper().scrape(url, stressContext(http));
      const second = await new InstagramScraper().scrape(url, stressContext(http));

      expect(first.outcome).toBe('failure');
      expect(second.outcome).toBe('failure');
    },
  );

  it('is deterministic: the same seed and shortcode always pick the same scenario', async () => {
    const mockAgentA = createSharedMockAgent();
    const mockAgentB = createSharedMockAgent();
    const profile: InstagramWorkloadProfile = {
      scenarios: { fast_path: 40, clips_page1: 30, post_429: 30 },
      clipsMaxPages: 2,
      clipsMaxAuthors: 3,
      latency: { minMs: 0, maxMs: 0 },
      responseSize: { targetBytes: 5_000 },
    };
    const docIds = { postDocId: POST_DOC_ID, clipsDocId: CLIPS_DOC_ID };
    const upstreamA = createInstagramMockUpstream(profile, SEED, docIds);
    const upstreamB = createInstagramMockUpstream(profile, SEED, docIds);
    upstreamA.register(mockAgentA);
    upstreamB.register(mockAgentB);
    const a = buildStressHttpClient(mockAgentA, upstreamA.computeLatencyMs);
    const b = buildStressHttpClient(mockAgentB, upstreamB.computeLatencyMs);

    const outcomes: [string, string][] = [];
    for (let index = 20; index < 40; index += 1) {
      const url = instagramSyntheticUrl(index);
      const resultA = await new InstagramScraper().scrape(url, stressContext(a.http));
      const resultB = await new InstagramScraper().scrape(url, stressContext(b.http));
      outcomes.push([resultA.outcome, resultB.outcome]);
    }

    for (const [outcomeA, outcomeB] of outcomes) {
      expect(outcomeA).toBe(outcomeB);
    }
    expect(new Set(outcomes.map(([outcomeA]) => outcomeA)).size).toBeGreaterThan(1);
  });
});
