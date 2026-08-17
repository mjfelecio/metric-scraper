import { z } from 'zod';

import { type ScrapedVideoData } from '../../core/models/snapshot.js';

import {
  InstagramParseError,
  parseJson,
  parseOptionalCount,
  parseRequiredCount,
  parseTimestamp,
} from './instagram-parser-utils.js';

const PostResponseSchema = z.object({
  data: z
    .object({
      xdt_api__v1__media__shortcode__web_info: z
        .object({ items: z.array(z.record(z.string(), z.unknown())) })
        .nullish(),
    })
    .nullish(),
  status: z.string().optional(),
  message: z.string().optional(),
});

export interface InstagramPostData extends ScrapedVideoData {
  shortcode: string;
  authorId: string;
  mediaType: number;
}

/** Parse Instagram's anonymous Polaris post metadata response. */
export function parseInstagramPostResponse(
  body: string,
  expectedShortcode: string,
  expectedMediaId: string,
): InstagramPostData {
  const parsed = PostResponseSchema.safeParse(parseJson(body, 'Instagram post'));
  if (!parsed.success)
    throw new InstagramParseError('Instagram post response has an invalid shape');
  if (parsed.data.status !== undefined && parsed.data.status !== 'ok') {
    throw new InstagramParseError(
      `Instagram post response failed${parsed.data.message === undefined ? '' : `: ${parsed.data.message}`}`,
    );
  }

  const item = parsed.data.data?.xdt_api__v1__media__shortcode__web_info?.items[0];
  if (item === undefined)
    throw new InstagramParseError('Instagram post response contains no media');

  const shortcode = stringField(item.code, 'code');
  if (shortcode !== expectedShortcode) {
    throw new InstagramParseError(
      `Instagram response shortcode ${shortcode} does not match ${expectedShortcode}`,
    );
  }
  const mediaType = parseRequiredCount(item.media_type, 'media_type');
  const user = recordField(item.user, 'user');
  const authorId = numericStringField(user.pk, 'user.pk');

  return {
    shortcode,
    authorId,
    mediaType,
    video_id: expectedMediaId,
    views: firstCount(item.play_count, item.view_count, item.video_view_count),
    likes: parseRequiredCount(item.like_count, 'like_count'),
    comments: parseRequiredCount(item.comment_count, 'comment_count'),
    shares: firstCount(item.reshare_count, item.share_count),
    saves: firstCount(item.save_count, item.saved_count),
    author_handle: stringField(user.username, 'user.username'),
    author_follower_count: firstCount(user.follower_count, user.followers_count),
    posted_at: parseTimestamp(item.taken_at, 'taken_at'),
  };
}

function firstCount(...values: unknown[]): number | null {
  for (const value of values) {
    if (value !== null && value !== undefined) return parseOptionalCount(value, 'metric count');
  }
  return null;
}

function recordField(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InstagramParseError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InstagramParseError(`${field} must be a non-empty string`);
  }
  return value;
}

function numericStringField(value: unknown, field: string): string {
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw new InstagramParseError(`${field} must be a numeric identifier`);
}
