import { z } from 'zod';

import { type ScrapedVideoData } from '../../core/models/snapshot.js';

import {
  InstagramParseError,
  parseJson,
  parseOptionalCount,
  parseRequiredCount,
  parseTimestamp,
} from './instagram-parser-utils.js';

const MediaInfoSchema = z.object({
  items: z.array(z.record(z.string(), z.unknown())),
  status: z.string().optional(),
  message: z.string().optional(),
});

/** Parse the authenticated mobile media-info response. */
export function parseInstagramMediaInfoResponse(
  body: string,
  expectedShortcode: string,
  expectedMediaId: string,
): ScrapedVideoData {
  const parsed = MediaInfoSchema.safeParse(parseJson(body, 'Instagram media-info'));
  if (!parsed.success)
    throw new InstagramParseError('Instagram media-info response has an invalid shape');
  if (parsed.data.status !== undefined && parsed.data.status !== 'ok') {
    throw new InstagramParseError(
      `Instagram media-info response failed${parsed.data.message === undefined ? '' : `: ${parsed.data.message}`}`,
    );
  }
  const item = parsed.data.items[0];
  if (item === undefined)
    throw new InstagramParseError('Instagram media-info response contains no media');
  if (item.code !== expectedShortcode) {
    throw new InstagramParseError('Instagram media-info response contains a different shortcode');
  }
  const user = asRecord(item.user, 'user');
  const username = user.username;
  if (typeof username !== 'string' || username.length === 0) {
    throw new InstagramParseError('user.username must be a non-empty string');
  }

  return {
    video_id: expectedMediaId,
    views: requiredFirstCount('play_count', item.play_count, item.view_count),
    likes: parseRequiredCount(item.like_count, 'like_count'),
    comments: parseRequiredCount(item.comment_count, 'comment_count'),
    shares: firstCount(item.reshare_count, item.share_count),
    saves: firstCount(item.save_count, item.saved_count),
    author_handle: username,
    author_follower_count: firstCount(user.follower_count, user.followers_count),
    posted_at: parseTimestamp(item.taken_at, 'taken_at'),
  };
}

function requiredFirstCount(field: string, ...values: unknown[]): number {
  const value = firstCount(...values);
  if (value === null) throw new InstagramParseError(`${field} is required`);
  return value;
}

function firstCount(...values: unknown[]): number | null {
  for (const value of values) {
    if (value !== null && value !== undefined) return parseOptionalCount(value, 'metric count');
  }
  return null;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InstagramParseError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}
