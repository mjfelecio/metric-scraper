import { z } from 'zod';

const CountSchema = z.union([z.number(), z.string()]);

const PlayerResponseSchema = z.object({
  items: z.array(
    z.object({
      id_str: z.string().regex(/^\d+$/, 'must be a numeric TikTok post id'),
      statistics_info: z.object({
        comment_count: CountSchema,
        digg_count: CountSchema,
        share_count: CountSchema,
      }),
    }),
  ),
});

export interface TikTokExactEngagement {
  likes: number;
  comments: number;
  shares: number;
}

export class TikTokPlayerParseError extends Error {
  override readonly name = 'TikTokPlayerParseError';
}

/** Parses exact interaction counters from TikTok's anonymous public player API. */
export function parseTikTokPlayerResponse(
  body: string,
  expectedVideoId: string,
): TikTokExactEngagement {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new TikTokPlayerParseError('TikTok player response does not contain valid JSON');
  }

  const parsed = PlayerResponseSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || 'payload'}: ${issue.message}`)
      .join('; ');
    throw new TikTokPlayerParseError(`TikTok player response is invalid: ${detail}`);
  }

  const item = parsed.data.items.find((candidate) => candidate.id_str === expectedVideoId);
  if (item === undefined) {
    throw new TikTokPlayerParseError(
      `TikTok player response does not contain requested id ${expectedVideoId}`,
    );
  }

  return {
    likes: parseCount(item.statistics_info.digg_count, 'statistics_info.digg_count'),
    comments: parseCount(item.statistics_info.comment_count, 'statistics_info.comment_count'),
    shares: parseCount(item.statistics_info.share_count, 'statistics_info.share_count'),
  };
}

function parseCount(value: number | string, field: string): number {
  const numeric = typeof value === 'number' ? value : /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new TikTokPlayerParseError(`${field} must be a safe non-negative integer`);
  }
  return numeric;
}
