import { describe, expect, it } from 'vitest';

import { ClockworksTikTokAdapter } from '../../scripts/apify-comparison/clockworks-tiktok-adapter.js';
import { type BenchmarkTarget } from '../../scripts/apify-comparison/types.js';

const adapter = new ClockworksTikTokAdapter();

function target(videoId: string, handle = 'creator'): BenchmarkTarget {
  return {
    videoId,
    url: `https://www.tiktok.com/@${handle}/video/${videoId}`,
    rawUrls: [],
    kind: 'video',
    handle,
  };
}

/** The flat output shape this Actor documents today. */
function flatRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '7643585712641559841',
    webVideoUrl: 'https://www.tiktok.com/@emrys8473/video/7643585712641559841',
    playCount: 1_234_567,
    diggCount: 45_120,
    commentCount: 891,
    shareCount: 212,
    collectCount: 3_004,
    createTimeISO: '2026-08-01T12:00:00.000Z',
    authorMeta: {
      name: 'emrys8473',
      signature: 'clips daily',
      fans: 120_400,
    },
    ...overrides,
  };
}

/** The nested shape seen on other builds of the same Actor family. */
function nestedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '7643585712641559841',
    submittedVideoUrl: 'https://www.tiktok.com/@emrys8473/video/7643585712641559841',
    stats: {
      playCount: 1_234_567,
      diggCount: 45_120,
      commentCount: 891,
      shareCount: 212,
      collectCount: 3_004,
    },
    author: { uniqueId: 'emrys8473', signature: 'clips daily' },
    authorStats: { followerCount: 120_400 },
    createTime: 1_785_931_200,
    ...overrides,
  };
}

describe('ClockworksTikTokAdapter.buildInput', () => {
  const input = adapter.buildInput([target('1'), target('2')]);

  it('submits exactly the normalized post URLs', () => {
    expect(input.postURLs).toEqual([
      'https://www.tiktok.com/@creator/video/1',
      'https://www.tiktok.com/@creator/video/2',
    ]);
  });

  it('disables every paid add-on explicitly rather than trusting Actor defaults', () => {
    expect(input).toMatchObject({
      scrapeRelatedVideos: false,
      scrapeAdditionalAuthorMeta: false,
      shouldDownloadVideos: false,
      shouldDownloadCovers: false,
      shouldDownloadAvatars: false,
      shouldDownloadMusicCovers: false,
      shouldDownloadSlideshowImages: false,
      shouldDownloadSubtitles: false,
      shouldTranscribeVideos: false,
      commentsPerPost: 0,
      repliesPerComment: 0,
    });
  });

  it('issues no discovery query of any kind', () => {
    expect(input.searchQueries).toEqual([]);
    expect(input.hashtags).toEqual([]);
    expect(input.profiles).toEqual([]);
  });

  it('records the feature flags for the report without the URL list', () => {
    const flags = adapter.describeFeatureFlags(input);
    expect(flags).toMatchObject({ shouldDownloadVideos: false, commentsPerPost: 0 });
    expect(flags).not.toHaveProperty('postURLs');
  });
});

describe('ClockworksTikTokAdapter.normalizeRow', () => {
  it('reads the flat output shape', () => {
    const row = adapter.normalizeRow(flatRow());
    expect(row).toMatchObject({
      kind: 'ok',
      videoId: '7643585712641559841',
      metrics: {
        views: 1_234_567,
        likes: 45_120,
        comments: 891,
        shares: 212,
        saves: 3_004,
        authorHandle: 'emrys8473',
        authorBio: 'clips daily',
        authorFollowerCount: 120_400,
        postedAt: '2026-08-01T12:00:00.000Z',
      },
    });
  });

  it('reads the nested output shape to the same result', () => {
    const flat = adapter.normalizeRow(flatRow());
    const nested = adapter.normalizeRow(nestedRow());

    expect(nested.kind).toBe('ok');
    expect(nested.videoId).toBe(flat.videoId);
    if (flat.kind !== 'ok' || nested.kind !== 'ok') throw new Error('expected ok rows');
    expect(nested.metrics.views).toBe(flat.metrics.views);
    expect(nested.metrics.saves).toBe(flat.metrics.saves);
    expect(nested.metrics.authorHandle).toBe(flat.metrics.authorHandle);
    expect(nested.metrics.authorBio).toBe(flat.metrics.authorBio);
    expect(nested.metrics.authorFollowerCount).toBe(flat.metrics.authorFollowerCount);
  });

  it('accepts numeric strings, which TikTok payloads sometimes carry', () => {
    const row = adapter.normalizeRow(flatRow({ playCount: '1234567', diggCount: ' 45120 ' }));
    if (row.kind !== 'ok') throw new Error('expected an ok row');
    expect(row.metrics.views).toBe(1_234_567);
    expect(row.metrics.likes).toBe(45_120);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['a non-numeric string', 'many'],
    ['negative', -5],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
  ])('turns %s views into null, never zero', (_label, value) => {
    const row = adapter.normalizeRow(flatRow({ playCount: value }));
    if (row.kind !== 'ok') throw new Error('expected an ok row');
    expect(row.metrics.views).toBeNull();
  });

  it('keeps a genuine zero as zero', () => {
    const row = adapter.normalizeRow(flatRow({ commentCount: 0 }));
    if (row.kind !== 'ok') throw new Error('expected an ok row');
    expect(row.metrics.comments).toBe(0);
  });

  it('recovers the video id from the URL when the row has no id field', () => {
    const row = adapter.normalizeRow(flatRow({ id: undefined }));
    expect(row.videoId).toBe('7643585712641559841');
  });

  it('leaves the video id null when nothing identifies the post', () => {
    const row = adapter.normalizeRow({ playCount: 10 });
    expect(row.videoId).toBeNull();
  });

  it.each([
    ['error', { error: 'video is private' }],
    ['errorDescription', { errorDescription: 'not found' }],
    ['errorMessage', { errorMessage: 'blocked' }],
  ])('surfaces an Actor error row via %s', (_label, overrides) => {
    const row = adapter.normalizeRow(flatRow(overrides));
    expect(row.kind).toBe('error');
    if (row.kind !== 'error') throw new Error('expected an error row');
    expect(row.message.length).toBeGreaterThan(0);
  });

  it('rejects a row that is not an object', () => {
    expect(adapter.normalizeRow('nope').kind).toBe('error');
    expect(adapter.normalizeRow(null).kind).toBe('error');
  });

  it('converts an epoch createTime to ISO', () => {
    const row = adapter.normalizeRow(nestedRow());
    if (row.kind !== 'ok') throw new Error('expected an ok row');
    expect(row.metrics.postedAt).toBe(new Date(1_785_931_200_000).toISOString());
  });

  it('leaves an unusable createTime as null', () => {
    const row = adapter.normalizeRow(flatRow({ createTimeISO: 'not a date', createTime: 0 }));
    if (row.kind !== 'ok') throw new Error('expected an ok row');
    expect(row.metrics.postedAt).toBeNull();
  });
});
