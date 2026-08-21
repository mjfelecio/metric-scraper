import { describe, expect, it } from 'vitest';

import { appendMetricPoint, MAX_METRIC_POINTS } from '../../src/app/metric-series.js';
import { type MetricPointDto } from '../../src/app/types.js';
import { type CycleSummary } from '../../src/core/models/session-summary.js';
import { type MetricSnapshot } from '../../src/core/models/snapshot.js';

function cycle(n: number): CycleSummary {
  const at = new Date(Date.UTC(2026, 7, 19, 16, 40 + n, 0)).toISOString();
  return {
    cycle: n,
    scheduled_at: at,
    started_at: at,
    finished_at: at,
    lag_ms: 0,
    overran: false,
    summary: null,
    error: null,
  };
}

function snapshot(overrides: Partial<MetricSnapshot> = {}): MetricSnapshot {
  return {
    platform: 'tiktok',
    video_id: '123',
    url: 'https://www.tiktok.com/@a/video/123',
    scraped_at: '2026-08-19T16:42:18.000Z',
    views: 153_247,
    likes: 8_341,
    comments: 214,
    shares: 901,
    saves: 12,
    author_handle: 'a',
    author_follower_count: null,
    posted_at: null,
    status: 'ok',
    error: null,
    latency_ms: 400,
    attempts: 1,
    retries: 0,
    proxy_id: null,
    http_status: 200,
    ...overrides,
  };
}

describe('appendMetricPoint', () => {
  it('adds exactly one point per completed cycle', () => {
    const series: MetricPointDto[] = [];

    appendMetricPoint(series, cycle(1), snapshot());
    appendMetricPoint(series, cycle(2), snapshot({ views: 161_667 }));
    appendMetricPoint(series, cycle(3), snapshot({ views: 161_670 }));

    expect(series).toHaveLength(3);
    expect(series.map((point) => point.cycle)).toEqual([1, 2, 3]);
  });

  it('carries the exact scraped integers through untouched', () => {
    const series: MetricPointDto[] = [];
    appendMetricPoint(series, cycle(1), snapshot());

    expect(series[0]).toMatchObject({
      cycle: 1,
      at: '2026-08-19T16:42:18.000Z',
      status: 'ok',
      views: 153_247,
      likes: 8_341,
      comments: 214,
      shares: 901,
    });
  });

  it('still records a cycle that produced no result at all', () => {
    const series: MetricPointDto[] = [];
    appendMetricPoint(series, cycle(4), null);

    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({
      cycle: 4,
      // Falls back to when the cycle finished, since there is no scrape time.
      at: cycle(4).finished_at,
      status: 'error',
      views: null,
      likes: null,
      comments: null,
      shares: null,
    });
  });

  it('keeps a failed scrape as a null-valued point rather than dropping it', () => {
    const series: MetricPointDto[] = [];
    appendMetricPoint(
      series,
      cycle(5),
      snapshot({ status: 'rate_limited', views: null, likes: null, comments: null, shares: null }),
    );

    expect(series).toHaveLength(1);
    expect(series[0]?.status).toBe('rate_limited');
    expect(series[0]?.views).toBeNull();
  });

  it('trims the oldest points once the ceiling is reached', () => {
    const series: MetricPointDto[] = [];
    for (let n = 1; n <= MAX_METRIC_POINTS + 5; n += 1) {
      appendMetricPoint(series, cycle(n), snapshot({ views: n }));
    }

    expect(series).toHaveLength(MAX_METRIC_POINTS);
    // The newest cycle survives; the first five were dropped from the head.
    expect(series[0]?.cycle).toBe(6);
    expect(series[series.length - 1]?.cycle).toBe(MAX_METRIC_POINTS + 5);
  });
});
