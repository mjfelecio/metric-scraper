import { describe, expect, it, vi } from 'vitest';

import {
  type ApifyHttpResponse,
  type ApifyTransport,
} from '../../scripts/apify-comparison/apify-client.js';
import { ClockworksTikTokAdapter } from '../../scripts/apify-comparison/clockworks-tiktok-adapter.js';
import { CountingHttpClient } from '../../scripts/apify-comparison/counting-http-client.js';
import { type LoadedTargets } from '../../scripts/apify-comparison/load-targets.js';
import { resolveOptions } from '../../scripts/apify-comparison/options.js';
import { buildPlan, runComparison } from '../../scripts/apify-comparison/run-comparison.js';
import { scrapeFailure, scrapeSuccess } from '../../src/core/models/scrape-result.js';
import { EMPTY_VIDEO_DATA } from '../../src/core/models/snapshot.js';
import { type HttpClient } from '../../src/core/scraper/http-port.js';
import { type Scraper } from '../../src/core/scraper/scraper.js';

const TOKEN = 'apify_api_0123456789abcdef';
const VIDEO_A = '7643585712641559841';
const VIDEO_B = '7668862416435907873';

function loaded(): LoadedTargets {
  return {
    targets: [
      {
        videoId: VIDEO_A,
        url: `https://www.tiktok.com/@emrys8473/video/${VIDEO_A}`,
        rawUrls: [`https://www.tiktok.com/@emrys8473/video/${VIDEO_A}`],
        kind: 'video',
        handle: 'emrys8473',
      },
      {
        videoId: VIDEO_B,
        url: `https://www.tiktok.com/@emrys8473/video/${VIDEO_B}`,
        rawUrls: [`https://www.tiktok.com/@emrys8473/video/${VIDEO_B}`],
        kind: 'video',
        handle: 'emrys8473',
      },
    ],
    issues: [],
    rejected: [],
    totalCandidates: 2,
    duplicatesCollapsed: 0,
  };
}

/**
 * Local scraper stub: A reports a rounded 1.2M, B fails.
 *
 * It issues a real call through the injected client, as the production scraper
 * does, so the benchmark's byte accounting is actually exercised.
 */
const localScraper: Scraper = {
  platform: 'tiktok',
  scrape: async (url, context) => {
    await context.http.request({ url: `https://www.tiktok.com/embed/v2/${url.split('/').pop()}` });
    return url.endsWith(VIDEO_A)
      ? scrapeSuccess({
          ...EMPTY_VIDEO_DATA,
          video_id: VIDEO_A,
          views: 1_200_000,
          likes: 45_000,
          comments: 891,
          shares: 212,
          author_handle: 'emrys8473',
        })
      : scrapeFailure(
          'rate_limited',
          { code: 'blocked', message: 'TikTok blocked the request', retryable: true },
          { video_id: VIDEO_B },
        );
  },
};

function countingHttp(): CountingHttpClient {
  const inner: HttpClient = {
    request: () =>
      Promise.resolve({
        url: 'https://www.tiktok.com/embed/v2/1',
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'text/html' },
        body: 'x'.repeat(2_048),
        redirected: false,
        durationMs: 5,
      }),
  };
  return new CountingHttpClient(inner);
}

function json(status: number, body: unknown): ApifyHttpResponse {
  return { status, headers: {}, body: JSON.stringify(body) };
}

const RUN_DATA = {
  id: 'RUN1',
  actId: 'ACT1',
  status: 'SUCCEEDED',
  defaultDatasetId: 'DS1',
  buildNumber: '0.1.42',
  startedAt: '2026-08-19T10:00:00.000Z',
  finishedAt: '2026-08-19T10:00:09.000Z',
  usageTotalUsd: 0.008,
  chargedEventCounts: { 'video-result': 2 },
  stats: { netRxBytes: 300_000, netTxBytes: 9_000, runTimeSecs: 9 },
};

/** Dataset deliberately in reverse order, to prove the join is not positional. */
const DATASET = [
  { id: VIDEO_B, playCount: 5_000, diggCount: 40, commentCount: 2, shareCount: 1 },
  {
    id: VIDEO_A,
    playCount: 1_234_567,
    diggCount: 45_120,
    commentCount: 891,
    shareCount: 212,
    collectCount: 3_004,
    authorMeta: { name: 'emrys8473', signature: 'clips daily', fans: 120_400 },
  },
];

function executeDeps(transport: ApifyTransport) {
  return {
    options: resolveOptions({ inputPath: 'urls.txt', execute: true }, { APIFY_TOKEN: TOKEN }),
    loaded: loaded(),
    adapter: new ClockworksTikTokAdapter(),
    scraper: localScraper,
    http: countingHttp(),
    transport,
    sleep: (): Promise<void> => Promise.resolve(),
  };
}

describe('runComparison — dry run', () => {
  it('makes zero Apify requests and zero local requests', async () => {
    const request = vi.fn<ApifyTransport['request']>();
    const scrape = vi.fn<Scraper['scrape']>();
    const http = countingHttp();

    const outcome = await runComparison({
      options: resolveOptions({ inputPath: 'urls.txt' }, { APIFY_TOKEN: TOKEN }),
      loaded: loaded(),
      adapter: new ClockworksTikTokAdapter(),
      scraper: { platform: 'tiktok', scrape },
      http,
      transport: { request },
    });

    expect(outcome.mode).toBe('dry-run');
    expect(request).not.toHaveBeenCalled();
    expect(scrape).not.toHaveBeenCalled();
    expect(http.snapshot().requests).toBe(0);
  });

  it('reports the exact billable count, actor, cap and redacted input', async () => {
    const outcome = await runComparison({
      options: resolveOptions({ inputPath: 'urls.txt' }, {}),
      loaded: loaded(),
      adapter: new ClockworksTikTokAdapter(),
      scraper: localScraper,
      http: countingHttp(),
    });

    expect(outcome.plan).toMatchObject({
      actorId: 'clockworks/tiktok-scraper',
      actorPathId: 'clockworks~tiktok-scraper',
      billableUrls: 2,
      maxChargeUsd: 0.25,
    });
    expect(outcome.plan.urls).toHaveLength(2);
    expect(outcome.rows).toEqual([]);
    expect(outcome.summary).toBeNull();
  });

  it('shows the same Actor input execute would send', () => {
    const deps = {
      options: resolveOptions({ inputPath: 'urls.txt' }, {}),
      loaded: loaded(),
      adapter: new ClockworksTikTokAdapter(),
      scraper: localScraper,
      http: countingHttp(),
    };
    const plan = buildPlan(deps);

    expect(plan.redactedActorInput).toMatchObject({
      postURLs: plan.urls,
      shouldDownloadVideos: false,
      commentsPerPost: 0,
    });
  });
});

describe('runComparison — execute', () => {
  it("joins both sources by video id and keeps each one's failures its own", async () => {
    let call = 0;
    const transport: ApifyTransport = {
      request: () => {
        call += 1;
        return Promise.resolve(call === 1 ? json(201, { data: RUN_DATA }) : json(200, DATASET));
      },
    };

    const outcome = await runComparison(executeDeps(transport));

    expect(outcome.mode).toBe('execute');
    expect(outcome.apifyError).toBeNull();
    expect(outcome.rows.map((row) => row.videoId)).toEqual([VIDEO_A, VIDEO_B]);

    const first = outcome.rows[0];
    expect(first?.comparable).toBe(true);
    expect(first?.deltas.views).toMatchObject({
      local: 1_200_000,
      apify: 1_234_567,
      signed: 34_567,
    });
    expect(first?.viewPrecision.apifyMoreGranular).toBe(true);

    // Local failed on B; Apify succeeded. Neither stands in for the other.
    const second = outcome.rows[1];
    expect(second?.local.ok).toBe(false);
    expect(second?.apify.ok).toBe(true);
    expect(second?.comparable).toBe(false);
    expect(second?.deltas.views).toMatchObject({ onlyIn: 'apify' });
  });

  it('records cost, bandwidth and provenance from the run', async () => {
    let call = 0;
    const transport: ApifyTransport = {
      request: () => {
        call += 1;
        return Promise.resolve(call === 1 ? json(201, { data: RUN_DATA }) : json(200, DATASET));
      },
    };

    const outcome = await runComparison(executeDeps(transport));
    const summary = outcome.summary;
    if (summary === null) throw new Error('expected a summary');

    expect(summary.actor).toMatchObject({
      runId: 'RUN1',
      terminalStatus: 'SUCCEEDED',
      build: '0.1.42',
      datasetId: 'DS1',
    });
    expect(summary.economics.economics.usageTotalUsd).toBe(0.008);
    expect(summary.economics.economics.netRxBytes).toBe(300_000);
    expect(summary.economics.economics.localResponseBytes).toBeGreaterThan(0);
    expect(summary.viewGranularity.apifyMoreGranularAbove1m).toBe(1);
  });

  it('still reports the local side when Apify fails outright', async () => {
    const transport: ApifyTransport = {
      request: () => Promise.resolve(json(402, { error: 'out of credit' })),
    };

    const outcome = await runComparison(executeDeps(transport));

    expect(outcome.apifyError).toMatch(/billing reasons/);
    expect(outcome.rows).toHaveLength(2);
    expect(outcome.rows[0]?.local.ok).toBe(true);
    expect(outcome.rows[0]?.apify.ok).toBe(false);
    expect(outcome.rows.every((row) => !row.comparable)).toBe(true);
    expect(outcome.summary?.economics.economics.usageTotalUsd).toBeNull();
  });

  it('surfaces a dataset failure without discarding the run metadata', async () => {
    let call = 0;
    const transport: ApifyTransport = {
      request: () => {
        call += 1;
        return Promise.resolve(
          call === 1
            ? json(201, { data: RUN_DATA })
            : { status: 200, headers: {}, body: 'garbage' },
        );
      },
    };

    const outcome = await runComparison(executeDeps(transport));

    expect(outcome.apifyError).toMatch(/not valid JSON/);
    expect(outcome.apifyRun?.id).toBe('RUN1');
    expect(outcome.rows.every((row) => !row.apify.ok)).toBe(true);
  });

  it('refuses to run half-configured', async () => {
    await expect(
      runComparison({
        options: {
          ...resolveOptions({ inputPath: 'urls.txt', execute: true }, { APIFY_TOKEN: TOKEN }),
        },
        loaded: loaded(),
        adapter: new ClockworksTikTokAdapter(),
        scraper: localScraper,
        http: countingHttp(),
        // No transport supplied.
      }),
    ).rejects.toThrow(/requires both an Apify transport and a token/);
  });
});
