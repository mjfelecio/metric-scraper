import { describe, expect, it } from 'vitest';

import {
  createFailureSnapshot,
  createSuccessSnapshot,
  EMPTY_VIDEO_DATA,
  MetricSnapshotSchema,
  SNAPSHOT_FIELD_ORDER,
  type SnapshotContext,
} from '../../src/core/models/snapshot.js';

const context: SnapshotContext = {
  platform: 'tiktok',
  url: 'https://www.tiktok.com/@example/video/1',
  scrapedAt: new Date('2026-08-17T10:00:00.000Z'),
  latencyMs: 120,
};

describe('MetricSnapshotSchema', () => {
  it('accepts a fully populated success row', () => {
    const snapshot = createSuccessSnapshot(context, {
      ...EMPTY_VIDEO_DATA,
      video_id: 'abc123',
      views: 1000,
      likes: 10,
      comments: 2,
      shares: 1,
      saves: 0,
      author_handle: 'example',
      author_follower_count: 500,
      posted_at: '2026-08-10T09:00:00.000Z',
    });

    expect(MetricSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.status).toBe('ok');
    expect(snapshot.error).toBeNull();
  });

  it('accepts a row where every optional metric is null', () => {
    const snapshot = createSuccessSnapshot(context, EMPTY_VIDEO_DATA);
    expect(MetricSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.views).toBeNull();
  });

  it('rejects undefined in place of null, so every row has the same keys', () => {
    const snapshot = {
      ...createSuccessSnapshot(context, EMPTY_VIDEO_DATA),
      views: undefined,
    };
    expect(MetricSnapshotSchema.safeParse(snapshot).success).toBe(false);
  });

  it('rejects negative and fractional counts', () => {
    const base = createSuccessSnapshot(context, EMPTY_VIDEO_DATA);
    expect(MetricSnapshotSchema.safeParse({ ...base, likes: -1 }).success).toBe(false);
    expect(MetricSnapshotSchema.safeParse({ ...base, likes: 1.5 }).success).toBe(false);
  });

  it('validates request diagnostics and preserves nullable terminal details', () => {
    const base = createSuccessSnapshot(
      { ...context, attempts: 2, retries: 1, proxyId: null, httpStatus: 200 },
      EMPTY_VIDEO_DATA,
    );
    expect(base).toMatchObject({ attempts: 2, retries: 1, proxy_id: null, http_status: 200 });
    expect(MetricSnapshotSchema.safeParse({ ...base, attempts: -1 }).success).toBe(false);
    expect(MetricSnapshotSchema.safeParse({ ...base, retries: 0.5 }).success).toBe(false);
    expect(MetricSnapshotSchema.safeParse({ ...base, http_status: 99 }).success).toBe(false);
    expect(MetricSnapshotSchema.safeParse({ ...base, proxy_id: '' }).success).toBe(false);
  });

  it('rejects an unparseable scraped_at', () => {
    const base = createSuccessSnapshot(context, EMPTY_VIDEO_DATA);
    expect(MetricSnapshotSchema.safeParse({ ...base, scraped_at: 'yesterday' }).success).toBe(
      false,
    );
  });

  it('rejects an unknown status', () => {
    const base = createSuccessSnapshot(context, EMPTY_VIDEO_DATA);
    expect(MetricSnapshotSchema.safeParse({ ...base, status: 'maybe' }).success).toBe(false);
  });
});

describe('createFailureSnapshot', () => {
  it('produces a valid row that carries the error and keeps metrics null', () => {
    const snapshot = createFailureSnapshot(context, 'not_found', {
      code: 'not_found',
      message: 'post has been deleted',
      retryable: false,
    });

    expect(MetricSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.status).toBe('not_found');
    expect(snapshot.error).toBe('not_found: post has been deleted');
    expect(snapshot.views).toBeNull();
    expect(snapshot.latency_ms).toBe(120);
    expect(snapshot.url).toBe(context.url);
  });

  it('keeps whatever partial data was recovered', () => {
    const snapshot = createFailureSnapshot(
      context,
      'rate_limited',
      { code: 'rate_limited', message: 'throttled', retryable: true },
      { video_id: 'abc123', author_handle: 'example' },
    );

    expect(snapshot.video_id).toBe('abc123');
    expect(snapshot.author_handle).toBe('example');
    expect(snapshot.likes).toBeNull();
  });

  it('emits every declared field', () => {
    const snapshot = createFailureSnapshot(context, 'error', {
      code: 'unknown',
      message: 'boom',
      retryable: false,
    });
    expect(Object.keys(snapshot).sort()).toEqual([...SNAPSHOT_FIELD_ORDER].sort());
  });
});
