import { z } from 'zod';

import { type ScrapedVideoData } from '../../core/models/snapshot.js';

const HYDRATION_SCRIPT_ID = '__UNIVERSAL_DATA_FOR_REHYDRATION__';
const EMBED_STATE_SCRIPT_ID = '__FRONTITY_CONNECT_STATE__';

const RawCountSchema = z.union([z.number(), z.string()]);

const ItemStructSchema = z.object({
  id: z.string().regex(/^\d+$/, 'must be a numeric TikTok video id'),
  createTime: RawCountSchema.nullish(),
  stats: z.object({
    playCount: RawCountSchema,
    diggCount: RawCountSchema,
    commentCount: RawCountSchema,
    shareCount: RawCountSchema,
    collectCount: RawCountSchema.nullish(),
  }),
  author: z
    .object({
      uniqueId: z.string().min(1),
    })
    .nullish(),
  authorStats: z
    .object({
      followerCount: RawCountSchema.nullish(),
    })
    .nullish(),
});

const HydrationSchema = z.object({
  __DEFAULT_SCOPE__: z.object({
    'webapp.video-detail': z.object({
      itemInfo: z.object({
        itemStruct: ItemStructSchema,
      }),
    }),
  }),
});

const EmbedItemSchema = z.object({
  id: z.string().regex(/^\d+$/, 'must be a numeric TikTok post id'),
  createTime: RawCountSchema.nullish(),
  playCount: RawCountSchema,
  diggCount: RawCountSchema,
  commentCount: RawCountSchema,
  shareCount: RawCountSchema,
});

const EmbedRouteSchema = z.object({
  videoData: z.object({
    itemInfos: EmbedItemSchema,
    authorInfos: z
      .object({
        uniqueId: z.string().min(1),
      })
      .nullish(),
    authorStats: z
      .object({
        followerCount: RawCountSchema.nullish(),
      })
      .nullish(),
  }),
});

const EmbedStateSchema = z.object({
  source: z.object({
    data: z.record(z.string(), z.unknown()),
  }),
});

/** A stable parser error that the HTTP adapter can map onto `parse_error`. */
export class TikTokHydrationParseError extends Error {
  override readonly name = 'TikTokHydrationParseError';
}

/**
 * Parses the public post object embedded in TikTok's logged-out pages.
 *
 * This function deliberately knows nothing about HTTP, retries, proxies or
 * output rows. Keeping the volatile payload path here makes it inexpensive to
 * update and straightforward to test against sanitized HTML fixtures.
 */
export function parseTikTokHydrationHtml(html: string, expectedVideoId: string): ScrapedVideoData {
  const embedState = extractJsonScript(html, EMBED_STATE_SCRIPT_ID);
  if (embedState !== null) {
    return parseEmbedState(embedState, expectedVideoId);
  }

  const scriptBody = extractJsonScript(html, HYDRATION_SCRIPT_ID);
  if (scriptBody === null) {
    throw new TikTokHydrationParseError(
      `TikTok page is missing the ${EMBED_STATE_SCRIPT_ID} and ${HYDRATION_SCRIPT_ID} scripts`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(scriptBody);
  } catch {
    throw new TikTokHydrationParseError(`${HYDRATION_SCRIPT_ID} does not contain valid JSON`);
  }

  const parsed = HydrationSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || 'payload'}: ${issue.message}`)
      .join('; ');
    throw new TikTokHydrationParseError(`TikTok video payload is invalid: ${detail}`);
  }

  const item = parsed.data.__DEFAULT_SCOPE__['webapp.video-detail'].itemInfo.itemStruct;
  if (item.id !== expectedVideoId) {
    throw new TikTokHydrationParseError(
      `TikTok payload video id ${item.id} does not match requested id ${expectedVideoId}`,
    );
  }

  return {
    video_id: item.id,
    views: parseRequiredCount(item.stats.playCount, 'stats.playCount'),
    likes: parseRequiredCount(item.stats.diggCount, 'stats.diggCount'),
    comments: parseRequiredCount(item.stats.commentCount, 'stats.commentCount'),
    shares: parseRequiredCount(item.stats.shareCount, 'stats.shareCount'),
    saves: parseOptionalCount(item.stats.collectCount, 'stats.collectCount'),
    author_handle: item.author?.uniqueId ?? null,
    author_follower_count: parseOptionalCount(
      item.authorStats?.followerCount,
      'authorStats.followerCount',
    ),
    posted_at: parseOptionalTimestamp(item.createTime),
  };
}

function parseEmbedState(scriptBody: string, expectedVideoId: string): ScrapedVideoData {
  let raw: unknown;
  try {
    raw = JSON.parse(scriptBody);
  } catch {
    throw new TikTokHydrationParseError(`${EMBED_STATE_SCRIPT_ID} does not contain valid JSON`);
  }

  const state = EmbedStateSchema.safeParse(raw);
  if (!state.success) {
    throw new TikTokHydrationParseError('TikTok embed state has an invalid source data object');
  }

  const routeKey = `/embed/v2/${expectedVideoId}`;
  const route = EmbedRouteSchema.safeParse(state.data.source.data[routeKey]);
  if (!route.success) {
    const detail = route.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || 'payload'}: ${issue.message}`)
      .join('; ');
    throw new TikTokHydrationParseError(`TikTok embed video payload is invalid: ${detail}`);
  }

  const videoData = route.data.videoData;
  const item = videoData.itemInfos;
  if (item.id !== expectedVideoId) {
    throw new TikTokHydrationParseError(
      `TikTok payload video id ${item.id} does not match requested id ${expectedVideoId}`,
    );
  }

  return {
    video_id: item.id,
    views: parseRequiredCount(item.playCount, 'itemInfos.playCount'),
    likes: parseRequiredCount(item.diggCount, 'itemInfos.diggCount'),
    comments: parseRequiredCount(item.commentCount, 'itemInfos.commentCount'),
    shares: parseRequiredCount(item.shareCount, 'itemInfos.shareCount'),
    saves: null,
    author_handle: videoData.authorInfos?.uniqueId ?? null,
    author_follower_count: parseOptionalCount(
      videoData.authorStats?.followerCount,
      'authorStats.followerCount',
    ),
    posted_at: parseOptionalTimestamp(item.createTime),
  };
}

function extractJsonScript(html: string, scriptId: string): string | null {
  // The lookahead makes attribute ordering irrelevant while still requiring
  // the exact script id. Script JSON is raw text, so no HTML entity decoding is
  // appropriate here.
  const escapedId = escapeRegExp(scriptId);
  const scriptPattern = new RegExp(
    `<script\\b(?=[^>]*\\bid\\s*=\\s*(["'])${escapedId}\\1)[^>]*>([\\s\\S]*?)<\\/script\\s*>`,
    'i',
  );
  const match = scriptPattern.exec(html);
  const body = match?.[2]?.trim();
  return body === undefined || body.length === 0 ? null : body;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseRequiredCount(value: number | string, field: string): number {
  return parseCount(value, field);
}

function parseOptionalCount(
  value: number | string | null | undefined,
  field: string,
): number | null {
  if (value === null || value === undefined) return null;
  return parseCount(value, field);
}

function parseCount(value: number | string, field: string): number {
  let numeric: number;

  if (typeof value === 'number') {
    numeric = value;
  } else {
    if (!/^\d+$/.test(value)) {
      throw new TikTokHydrationParseError(`${field} must be a non-negative integer`);
    }
    numeric = Number(value);
  }

  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new TikTokHydrationParseError(`${field} must be a safe non-negative integer`);
  }
  return numeric;
}

function parseOptionalTimestamp(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const seconds = parseCount(value, 'createTime');
  const date = new Date(seconds * 1_000);
  if (Number.isNaN(date.getTime())) {
    throw new TikTokHydrationParseError('createTime is outside the supported date range');
  }

  try {
    return date.toISOString();
  } catch {
    throw new TikTokHydrationParseError('createTime is outside the supported date range');
  }
}
