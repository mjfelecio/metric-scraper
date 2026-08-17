import { describe, expect, it } from 'vitest';

import { parseInstagramClipsResponse } from '../../src/platforms/instagram/instagram-clips-parser.js';
import { parseInstagramMediaInfoResponse } from '../../src/platforms/instagram/instagram-media-info-parser.js';
import { parseInstagramPostResponse } from '../../src/platforms/instagram/instagram-post-parser.js';
import { shortcodeToMediaId } from '../../src/platforms/instagram/instagram-shortcode.js';

const CODE = 'DcBr7X4SL3h';
const MEDIA_ID = shortcodeToMediaId(CODE);

describe('Instagram response parsers', () => {
  it('parses exact post metadata without fabricating unavailable views', () => {
    const data = parseInstagramPostResponse(
      JSON.stringify({
        data: {
          xdt_api__v1__media__shortcode__web_info: {
            items: [
              {
                code: CODE,
                pk: MEDIA_ID,
                media_type: 2,
                play_count: null,
                view_count: null,
                like_count: 920205,
                comment_count: 18567,
                taken_at: 1_700_000_000,
                user: { pk: '25025320', username: 'instagram' },
              },
            ],
          },
        },
        status: 'ok',
      }),
      CODE,
      MEDIA_ID,
    );

    expect(data).toMatchObject({
      video_id: MEDIA_ID,
      views: null,
      likes: 920205,
      comments: 18567,
      author_handle: 'instagram',
      authorId: '25025320',
      mediaType: 2,
      posted_at: '2023-11-14T22:13:20.000Z',
    });
  });

  it('finds an exact play count in recent clips', () => {
    const views = parseInstagramClipsResponse(
      JSON.stringify({
        data: {
          xdt_api__v1__clips__user__connection_v2: {
            edges: [
              { node: { media: { code: 'other', play_count: 1 } } },
              { node: { media: { code: CODE, play_count: 96047130 } } },
            ],
          },
        },
        status: 'ok',
      }),
      CODE,
    );
    expect(views).toBe(96047130);
  });

  it('returns null when a Reel is not in the recent clips page', () => {
    const views = parseInstagramClipsResponse(
      JSON.stringify({
        data: {
          xdt_api__v1__clips__user__connection_v2: {
            edges: [{ node: { media: { code: 'other', play_count: 1 } } }],
          },
        },
        status: 'ok',
      }),
      CODE,
    );
    expect(views).toBeNull();
  });

  it('parses authenticated media-info and prefers play_count', () => {
    const data = parseInstagramMediaInfoResponse(
      JSON.stringify({
        items: [
          {
            code: CODE,
            play_count: 96047130,
            view_count: 90000000,
            like_count: 920205,
            comment_count: 18567,
            reshare_count: 42,
            taken_at: 1_700_000_000,
            user: { username: 'instagram', follower_count: 700000000 },
          },
        ],
        status: 'ok',
      }),
      CODE,
      MEDIA_ID,
    );

    expect(data).toMatchObject({
      views: 96047130,
      likes: 920205,
      comments: 18567,
      shares: 42,
      author_follower_count: 700000000,
    });
  });

  it('rejects abbreviated and mismatched metric payloads', () => {
    expect(() =>
      parseInstagramClipsResponse(
        JSON.stringify({
          data: {
            xdt_api__v1__clips__user__connection_v2: {
              edges: [{ node: { media: { code: CODE, play_count: '96M' } } }],
            },
          },
          status: 'ok',
        }),
        CODE,
      ),
    ).toThrow(/safe non-negative integer/);
  });
});
