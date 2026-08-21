/**
 * Realistic-shaped TikTok response bodies, verified field-for-field against
 * `tests/platforms/tiktok-scraper.test.ts`'s own fixtures so the real,
 * unmodified `TikTokHydrationParseError`/`TikTokPlayerParseError` parsers
 * accept them. Padded to a configurable wire size so bandwidth telemetry
 * exercises something realistic rather than a bare-minimum stub.
 */

export interface TikTokEmbedFixtureInput {
  videoId: string;
  createTimeSeconds: number;
  playCount: number;
  diggCount: number;
  commentCount: number;
  shareCount: number;
  authorHandle: string;
  followerCount: number;
  targetBytes: number;
}

export function buildTikTokEmbedHtml(input: TikTokEmbedFixtureInput): string {
  const state = {
    source: {
      data: {
        [`/embed/v2/${input.videoId}`]: {
          videoData: {
            itemInfos: {
              id: input.videoId,
              createTime: input.createTimeSeconds,
              playCount: input.playCount,
              diggCount: input.diggCount,
              commentCount: input.commentCount,
              shareCount: input.shareCount,
            },
            authorInfos: { uniqueId: input.authorHandle },
            authorStats: { followerCount: input.followerCount },
          },
        },
      },
    },
  };
  const script = `<script id="__FRONTITY_CONNECT_STATE__">${JSON.stringify(state)}</script>`;
  const head = '<!doctype html><html><head><title>TikTok</title></head><body>';
  const tail = '</body></html>';
  return `${head}${pad(head + script + tail, input.targetBytes)}${script}${tail}`;
}

export interface TikTokPlayerFixtureInput {
  videoId: string;
  likes: number;
  comments: number;
  shares: number;
  targetBytes: number;
}

export function buildTikTokPlayerJson(input: TikTokPlayerFixtureInput): string {
  const payload: Record<string, unknown> = {
    items: [
      {
        id_str: input.videoId,
        statistics_info: {
          comment_count: input.comments,
          digg_count: input.likes,
          share_count: input.shares,
        },
      },
    ],
  };
  return padJson(payload, input.targetBytes);
}

/** Realistic TikTok challenge/verification page marker, matching `looksLikeChallengePage`. */
export function buildTikTokChallengeHtml(targetBytes: number): string {
  const body =
    '<!doctype html><html><body><div class="captcha-verify-container"></div></body></html>';
  return body + '\n<!-- ' + fillerChars(Math.max(0, targetBytes - body.length - 9)) + ' -->';
}

/** Byte length appended as an HTML comment so the surrounding markup stays realistic. */
function pad(existing: string, targetBytes: number): string {
  const currentBytes = Buffer.byteLength(existing, 'utf8');
  const paddingBytes = Math.max(0, targetBytes - currentBytes - 9);
  return paddingBytes > 0 ? `<!-- ${fillerChars(paddingBytes)} -->` : '';
}

/** Appends a filler field to a JSON object so unknown-field-tolerant Zod schemas still parse it. */
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
