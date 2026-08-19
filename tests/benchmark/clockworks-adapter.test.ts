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

  /**
   * Field names are checked against the Actor's published input schema, not
   * guessed. A misspelled flag is silently ignored by Apify, which is the
   * failure mode that costs money without ever raising an error.
   */
  it('disables every paid add-on explicitly rather than trusting Actor defaults', () => {
    expect(input).toMatchObject({
      scrapeRelatedVideos: false,
      scrapeRelatedSearchWords: false,
      scrapeAdditionalAuthorMeta: false,
      shouldDownloadVideos: false,
      shouldDownloadCovers: false,
      shouldDownloadAvatars: false,
      shouldDownloadMusicCovers: false,
      shouldDownloadSlideshowImages: false,
      commentsPerPost: 0,
      topLevelCommentsPerPost: 0,
      maxRepliesPerComment: 0,
    });
  });

  it('turns subtitles off through the enum the Actor actually has', () => {
    expect(input.downloadSubtitlesOptions).toBe('NEVER_DOWNLOAD_SUBTITLES');
    // Transcription is a value of that enum, not a field. Naming it as a
    // boolean would look disabled while doing nothing at all.
    expect(input).not.toHaveProperty('shouldTranscribeVideos');
    expect(input).not.toHaveProperty('shouldDownloadSubtitles');
  });

  it('disables the per-video-second AI extras, the costliest options here', () => {
    expect(input.aiVideoDescription).toBe(false);
    expect(input.aiVideoSummary).toBe(false);
  });

  it('issues no discovery query of any kind', () => {
    expect(input.searchQueries).toEqual([]);
    expect(input.hashtags).toEqual([]);
    expect(input.profiles).toEqual([]);
  });

  it('records the feature flags for the report without the URL list', () => {
    const flags = adapter.describeFeatureFlags(input);
    expect(flags).toMatchObject({
      shouldDownloadVideos: false,
      commentsPerPost: 0,
      // The enum must survive into the record, or the artifact cannot prove
      // which subtitle setting the paid run actually used.
      downloadSubtitlesOptions: 'NEVER_DOWNLOAD_SUBTITLES',
      aiVideoDescription: false,
    });
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

  /** The shape this Actor actually documents for a failed URL. */
  it('reads the documented error row, which carries an errorCode', () => {
    const row = adapter.normalizeRow({
      url: 'https://www.tiktok.com/@someuser/video/7643585712641559841',
      input: 'someuser',
      error: 'Post not found or private',
      errorCode: 'POST_NOT_FOUND_OR_PRIVATE',
    });

    expect(row.kind).toBe('error');
    if (row.kind !== 'error') throw new Error('expected an error row');
    // The code is machine-readable and worth keeping in front of the message.
    expect(row.message).toBe('POST_NOT_FOUND_OR_PRIVATE: Post not found or private');
    // Still joinable, so the failure lands on the right video rather than
    // becoming an unmatched row.
    expect(row.videoId).toBe('7643585712641559841');
  });

  it('treats an errorCode with no message as a failure, not a null-metric success', () => {
    const row = adapter.normalizeRow({ id: '7643585712641559841', errorCode: 'NOT_FOUND' });

    // The regression that matters: without the errorCode check this fell
    // through as `ok` with every metric null, inflating Apify's success count.
    expect(row.kind).toBe('error');
    if (row.kind !== 'error') throw new Error('expected an error row');
    expect(row.message).toBe('NOT_FOUND');
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
