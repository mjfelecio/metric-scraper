import { z } from 'zod';

import { type ScrapeErrorInfo } from './errors.js';
import { PlatformSchema, type Platform } from './platform.js';
import { ScrapeStatusSchema, type FailureStatus } from './status.js';

/**
 * A metric that may legitimately be absent (the platform does not expose it, or
 * this particular post type does not have it). Absence is `null` — never
 * `undefined`, so that every JSONL row has the same keys.
 */
const NullableCount = z.number().int().nonnegative().nullable();

/** ISO-8601 timestamp. Validated by parseability rather than by regex. */
const IsoTimestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: 'must be an ISO-8601 timestamp',
});

/**
 * One row of output: the state of one video's public metrics at one point in time.
 *
 * This is an append-only observation, NOT an entity. `video_id` is not a unique
 * key — scraping the same video twice intentionally produces two rows, and that
 * is the whole point of the dataset.
 *
 * Field names are snake_case because this is a data interchange contract, not a
 * TypeScript-internal shape.
 */
export const MetricSnapshotSchema = z.object({
  platform: PlatformSchema,
  /** Platform-native video id, when it could be determined. */
  video_id: z.string().min(1).nullable(),
  /** The normalized URL that was actually requested. */
  url: z.string().min(1),
  scraped_at: IsoTimestamp,
  views: NullableCount,
  likes: NullableCount,
  comments: NullableCount,
  shares: NullableCount,
  saves: NullableCount,
  author_handle: z.string().min(1).nullable(),
  author_follower_count: NullableCount,
  /** When the post was published, if exposed by the platform. */
  posted_at: IsoTimestamp.nullable(),
  status: ScrapeStatusSchema,
  /** `"<error_code>: <message>"` on failure, `null` on success. */
  error: z.string().nullable(),
  /** Wall-clock duration of the acquisition attempt chain, including retries. */
  latency_ms: z.number().int().nonnegative(),
});

export type MetricSnapshot = z.infer<typeof MetricSnapshotSchema>;

/**
 * The subset of a snapshot a platform implementation is responsible for
 * producing. Everything else (url, timing, status) is filled in by the runner,
 * so platform code cannot get the bookkeeping wrong.
 */
export const ScrapedVideoDataSchema = MetricSnapshotSchema.pick({
  video_id: true,
  views: true,
  likes: true,
  comments: true,
  shares: true,
  saves: true,
  author_handle: true,
  author_follower_count: true,
  posted_at: true,
});

export type ScrapedVideoData = z.infer<typeof ScrapedVideoDataSchema>;

/** Every metric field absent. Useful as a base for partial acquisitions. */
export const EMPTY_VIDEO_DATA: ScrapedVideoData = {
  video_id: null,
  views: null,
  likes: null,
  comments: null,
  shares: null,
  saves: null,
  author_handle: null,
  author_follower_count: null,
  posted_at: null,
};

/** Canonical column order, used by the JSONL serializer so rows are diff-friendly. */
export const SNAPSHOT_FIELD_ORDER = [
  'platform',
  'video_id',
  'url',
  'scraped_at',
  'views',
  'likes',
  'comments',
  'shares',
  'saves',
  'author_handle',
  'author_follower_count',
  'posted_at',
  'status',
  'error',
  'latency_ms',
] as const satisfies readonly (keyof MetricSnapshot)[];

export function formatErrorField(error: ScrapeErrorInfo): string {
  return `${error.code}: ${error.message}`;
}

export interface SnapshotContext {
  platform: Platform;
  url: string;
  scrapedAt: Date;
  latencyMs: number;
}

export function createSuccessSnapshot(
  context: SnapshotContext,
  data: ScrapedVideoData,
): MetricSnapshot {
  return {
    platform: context.platform,
    video_id: data.video_id,
    url: context.url,
    scraped_at: context.scrapedAt.toISOString(),
    views: data.views,
    likes: data.likes,
    comments: data.comments,
    shares: data.shares,
    saves: data.saves,
    author_handle: data.author_handle,
    author_follower_count: data.author_follower_count,
    posted_at: data.posted_at,
    status: 'ok',
    error: null,
    latency_ms: context.latencyMs,
  };
}

/**
 * A failed scrape is still a complete, valid row. Nothing is dropped: the
 * caller always gets a snapshot back, with the metric fields left null.
 */
export function createFailureSnapshot(
  context: SnapshotContext,
  status: FailureStatus,
  error: ScrapeErrorInfo,
  partial: Partial<ScrapedVideoData> = {},
): MetricSnapshot {
  const data: ScrapedVideoData = { ...EMPTY_VIDEO_DATA, ...partial };
  return {
    platform: context.platform,
    video_id: data.video_id,
    url: context.url,
    scraped_at: context.scrapedAt.toISOString(),
    views: data.views,
    likes: data.likes,
    comments: data.comments,
    shares: data.shares,
    saves: data.saves,
    author_handle: data.author_handle,
    author_follower_count: data.author_follower_count,
    posted_at: data.posted_at,
    status,
    error: formatErrorField(error),
    latency_ms: context.latencyMs,
  };
}
