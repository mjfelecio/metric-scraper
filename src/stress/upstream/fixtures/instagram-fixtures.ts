/**
 * Realistic-shaped Instagram response bodies, verified field-for-field
 * against `tests/platforms/instagram-scraper.test.ts`'s own fixtures so the
 * real, unmodified `InstagramScraper`/parsers accept them. Padded to a
 * configurable wire size so bandwidth telemetry exercises something
 * realistic rather than a bare-minimum stub.
 */

export function buildInstagramRootHtml(targetBytes: number): string {
  const body = '<!doctype html><html><head><title>Instagram</title></head><body></body></html>';
  return body + padComment(body, targetBytes);
}

/** `csrftoken` cookie the anonymous bootstrap expects to find in `set-cookie`. */
export function buildInstagramRootSetCookie(csrf: string): string {
  return `csrftoken=${csrf}; Path=/; Secure, mid=stress-mid; Path=/; Secure`;
}

export interface InstagramPostFixtureInput {
  shortcode: string;
  mediaPk: string;
  mediaType?: number;
  playCount: number | null;
  likeCount: number;
  commentCount: number;
  takenAtSeconds: number;
  authorId: string;
  authorHandle: string;
  coauthorIds?: string[];
  targetBytes: number;
}

export function buildInstagramPostJson(input: InstagramPostFixtureInput): string {
  const payload: Record<string, unknown> = {
    data: {
      xdt_api__v1__media__shortcode__web_info: {
        items: [
          {
            code: input.shortcode,
            pk: input.mediaPk,
            media_type: input.mediaType ?? 2,
            play_count: input.playCount,
            view_count: null,
            like_count: input.likeCount,
            comment_count: input.commentCount,
            taken_at: input.takenAtSeconds,
            user: { pk: input.authorId, username: input.authorHandle },
            coauthor_producers: (input.coauthorIds ?? []).map((pk) => ({ pk })),
          },
        ],
      },
    },
    status: 'ok',
  };
  return padJson(payload, input.targetBytes);
}

export interface InstagramClipsFixtureInput {
  /** `null` -> no match on this page: empty edges. */
  match: { shortcode: string; playCount: number } | null;
  hasNextPage: boolean;
  endCursor: string | null;
  targetBytes: number;
}

export function buildInstagramClipsJson(input: InstagramClipsFixtureInput): string {
  const payload: Record<string, unknown> = {
    data: {
      xdt_api__v1__clips__user__connection_v2: {
        edges:
          input.match === null
            ? []
            : [
                {
                  node: {
                    media: { code: input.match.shortcode, play_count: input.match.playCount },
                  },
                },
              ],
        page_info: { end_cursor: input.endCursor, has_next_page: input.hasNextPage },
      },
    },
    status: 'ok',
  };
  return padJson(payload, input.targetBytes);
}

export interface InstagramMediaInfoFixtureInput {
  shortcode: string;
  playCount: number;
  likeCount: number;
  commentCount: number;
  takenAtSeconds: number;
  authorHandle: string;
  targetBytes: number;
}

export function buildInstagramMediaInfoJson(input: InstagramMediaInfoFixtureInput): string {
  const payload: Record<string, unknown> = {
    items: [
      {
        code: input.shortcode,
        play_count: input.playCount,
        like_count: input.likeCount,
        comment_count: input.commentCount,
        taken_at: input.takenAtSeconds,
        user: { username: input.authorHandle },
      },
    ],
    status: 'ok',
  };
  return padJson(payload, input.targetBytes);
}

/** A response whose top level is not the object the parsers expect at all. */
export function buildMalformedJson(): string {
  return '{"data": "this is not an object", "status": "ok"';
}

/** Valid JSON, valid top-level shape, but missing a field the parser requires (`like_count`). */
export function buildInstagramPostMissingFieldsJson(input: {
  shortcode: string;
  authorId: string;
  authorHandle: string;
  targetBytes: number;
}): string {
  const payload: Record<string, unknown> = {
    data: {
      xdt_api__v1__media__shortcode__web_info: {
        items: [
          {
            code: input.shortcode,
            media_type: 2,
            play_count: 1000,
            // like_count intentionally omitted -- parseRequiredCount throws.
            comment_count: 10,
            taken_at: 1_700_000_000,
            user: { pk: input.authorId, username: input.authorHandle },
          },
        ],
      },
    },
    status: 'ok',
  };
  return padJson(payload, input.targetBytes);
}

function padComment(existing: string, targetBytes: number): string {
  const currentBytes = Buffer.byteLength(existing, 'utf8');
  const paddingBytes = Math.max(0, targetBytes - currentBytes - 9);
  return paddingBytes > 0 ? `<!-- ${fillerChars(paddingBytes)} -->` : '';
}

function padJson(payload: Record<string, unknown>, targetBytes: number): string {
  const base = JSON.stringify(payload);
  const currentBytes = Buffer.byteLength(base, 'utf8');
  if (currentBytes >= targetBytes) return base;
  const paddingBytes = targetBytes - currentBytes - 24;
  if (paddingBytes <= 0) return base;
  return JSON.stringify({ ...payload, __stress_filler: fillerChars(paddingBytes) });
}

function fillerChars(count: number): string {
  return 'x'.repeat(Math.max(0, count));
}
