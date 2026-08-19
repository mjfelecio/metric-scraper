import { describe, expect, it } from 'vitest';

import { adapterFor, supportedActorIds } from '../../scripts/apify-comparison/adapter-registry.js';
import {
  MIN_ACTOR_MAX_ITEMS,
  NoviTikTokAdapter,
} from '../../scripts/apify-comparison/novi-tiktok-adapter.js';
import { type BenchmarkTarget } from '../../scripts/apify-comparison/types.js';

const adapter = new NoviTikTokAdapter();

function target(videoId: string, handle = 'creator'): BenchmarkTarget {
  return {
    videoId,
    url: `https://www.tiktok.com/@${handle}/video/${videoId}`,
    rawUrls: [],
    kind: 'video',
    handle,
  };
}

/** TikTok's mobile payload shape, as published in the Actor's sample output. */
function mobileRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    aweme_id: '7229167805625847041',
    share_url: 'https://www.tiktok.com/@vtvgiaitriofficial/video/7229167805625847041',
    statistics: {
      play_count: 585_709,
      digg_count: 25_006,
      comment_count: 183,
      share_count: 492,
      collect_count: 743,
    },
    author: {
      unique_id: 'vtvgiaitriofficial',
      nickname: 'VTV Giai Tri Official',
      signature: 'official channel',
      follower_count: 1_204_000,
    },
    create_time: 1_683_171_893,
    ...overrides,
  };
}

describe('NoviTikTokAdapter.buildInput', () => {
  const input = adapter.buildInput([target('1'), target('2')]);

  it('submits the normalized URLs as plain strings, not request objects', () => {
    // The published schema uses editor `stringList`. Wrapping these in
    // `{ url }` objects is the shape most Apify Actors take, and would be
    // silently ignored here — a paid run against an empty URL list.
    expect(input.startUrls).toEqual([
      'https://www.tiktok.com/@creator/video/1',
      'https://www.tiktok.com/@creator/video/2',
    ]);
    for (const url of input.startUrls as unknown[]) {
      expect(typeof url).toBe('string');
    }
  });

  it('honours the schema minimum of 20 for maxItems', () => {
    // Below the minimum the Actor rejects the input outright, so a two-URL
    // benchmark still has to ask for 20. Spend is bounded by the URL count and
    // maxTotalChargeUsd instead.
    expect(input.maxItems).toBe(MIN_ACTOR_MAX_ITEMS);
  });

  it('raises maxItems above the floor when more URLs are submitted', () => {
    const many = adapter.buildInput(Array.from({ length: 25 }, (_, i) => target(String(i))));
    expect(many.maxItems).toBe(25);
  });

  it('sets no search-mode field, which is how a URL run becomes a bulk run', () => {
    expect(input).not.toHaveProperty('keywords');
    expect(input).not.toHaveProperty('dateRange');
    expect(input).not.toHaveProperty('sortType');
    expect(input).not.toHaveProperty('location');
  });

  it('invents no reassuring disable flags this Actor does not have', () => {
    // This Actor publishes no download/comment/AI options. Adding them would
    // read as protection in the artifact while doing nothing, because Apify
    // drops unknown input fields without an error.
    expect(input).not.toHaveProperty('shouldDownloadVideos');
    expect(input).not.toHaveProperty('commentsPerPost');
    expect(input).not.toHaveProperty('aiVideoDescription');
    expect(Object.keys(input).sort()).toEqual(['maxItems', 'startUrls']);
  });

  it('records the flags for the report without the URL list', () => {
    const flags = adapter.describeFeatureFlags(input);
    expect(flags).toEqual({ maxItems: MIN_ACTOR_MAX_ITEMS });
    expect(flags).not.toHaveProperty('startUrls');
  });
});

describe('NoviTikTokAdapter.normalizeRow', () => {
  it('reads the mobile snake_case shape', () => {
    const row = adapter.normalizeRow(mobileRow());
    expect(row).toMatchObject({
      kind: 'ok',
      videoId: '7229167805625847041',
      metrics: {
        views: 585_709,
        likes: 25_006,
        comments: 183,
        shares: 492,
        saves: 743,
        authorHandle: 'vtvgiaitriofficial',
        authorBio: 'official channel',
        authorFollowerCount: 1_204_000,
      },
    });
  });

  it('falls back to flattened top-level counts', () => {
    const row = adapter.normalizeRow({
      aweme_id: '7229167805625847041',
      play_count: 585_709,
      digg_count: 25_006,
    });
    if (row.kind !== 'ok') throw new Error('expected an ok row');
    expect(row.metrics.views).toBe(585_709);
    expect(row.metrics.likes).toBe(25_006);
  });

  it('accepts numeric strings', () => {
    const row = adapter.normalizeRow(
      mobileRow({ statistics: { play_count: '585709', digg_count: ' 25006 ' } }),
    );
    if (row.kind !== 'ok') throw new Error('expected an ok row');
    expect(row.metrics.views).toBe(585_709);
    expect(row.metrics.likes).toBe(25_006);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['a non-numeric string', 'many'],
    ['negative', -5],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
  ])('turns %s views into null, never zero', (_label, value) => {
    const row = adapter.normalizeRow(mobileRow({ statistics: { play_count: value } }));
    if (row.kind !== 'ok') throw new Error('expected an ok row');
    expect(row.metrics.views).toBeNull();
  });

  it('keeps a genuine zero as zero', () => {
    const row = adapter.normalizeRow(mobileRow({ statistics: { comment_count: 0 } }));
    if (row.kind !== 'ok') throw new Error('expected an ok row');
    expect(row.metrics.comments).toBe(0);
  });

  it('converts create_time seconds to ISO', () => {
    const row = adapter.normalizeRow(mobileRow());
    if (row.kind !== 'ok') throw new Error('expected an ok row');
    expect(row.metrics.postedAt).toBe(new Date(1_683_171_893_000).toISOString());
  });

  it('recovers the video id from share_url when aweme_id is absent', () => {
    const row = adapter.normalizeRow(mobileRow({ aweme_id: undefined }));
    expect(row.videoId).toBe('7229167805625847041');
  });

  it('treats a non-zero status_code as a failure even with statistics present', () => {
    const row = adapter.normalizeRow(
      mobileRow({ status_code: 10_204, status_msg: 'item not found' }),
    );
    expect(row.kind).toBe('error');
    if (row.kind !== 'error') throw new Error('expected an error row');
    expect(row.message).toBe('status_code 10204: item not found');
    // Still joinable, so the failure lands on the right video.
    expect(row.videoId).toBe('7229167805625847041');
  });

  it('treats status_code 0 as success, since that is the mobile API OK value', () => {
    expect(adapter.normalizeRow(mobileRow({ status_code: 0 })).kind).toBe('ok');
  });

  it('surfaces a generic Apify error row', () => {
    const row = adapter.normalizeRow(mobileRow({ errorCode: 'NOT_FOUND', error: 'gone' }));
    expect(row.kind).toBe('error');
    if (row.kind !== 'error') throw new Error('expected an error row');
    expect(row.message).toBe('NOT_FOUND: gone');
  });

  /**
   * The Actor warns that a 404 URL is still charged but documents no error
   * shape, so the empty row has to be caught structurally.
   */
  it('treats a structurally empty row as a failure, not a null-metric success', () => {
    const row = adapter.normalizeRow({ input: 'https://www.tiktok.com/@nobody/video/1' });
    expect(row.kind).toBe('error');
    if (row.kind !== 'error') throw new Error('expected an error row');
    expect(row.message).toMatch(/neither a video id nor a statistics block/);
  });

  it('rejects a row that is not an object', () => {
    expect(adapter.normalizeRow('nope').kind).toBe('error');
    expect(adapter.normalizeRow(null).kind).toBe('error');
  });
});

describe('adapterFor', () => {
  it('resolves both supported Actors to their own adapter', () => {
    expect(adapterFor('clockworks/tiktok-scraper').actorId).toBe('clockworks/tiktok-scraper');
    expect(adapterFor('novi/tiktok-scraper-ultimate').actorId).toBe('novi/tiktok-scraper-ultimate');
  });

  it('accepts the owner~name request-path spelling', () => {
    expect(adapterFor('novi~tiktok-scraper-ultimate').actorId).toBe('novi/tiktok-scraper-ultimate');
  });

  it('refuses an unregistered Actor instead of falling back to Clockworks', () => {
    // The regression this guards: --actor used to change only the API path,
    // so an unsupported Actor was charged for and parsed with the wrong reader.
    expect(() => adapterFor('apidojo/tiktok-scraper')).toThrow(/No adapter is registered/);
    expect(() => adapterFor('apidojo/tiktok-scraper')).toThrow(/clockworks\/tiktok-scraper/);
  });

  it('lists exactly the Actors that have adapters', () => {
    expect(supportedActorIds()).toEqual([
      'clockworks/tiktok-scraper',
      'novi/tiktok-scraper-ultimate',
    ]);
  });
});
