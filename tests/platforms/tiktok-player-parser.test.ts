import { describe, expect, it } from 'vitest';

import {
  parseTikTokPlayerResponse,
  TikTokPlayerParseError,
} from '../../src/platforms/tiktok/tiktok-player-parser.js';

const VIDEO_ID = '7420000000000000001';

function response(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    items: [
      {
        id_str: VIDEO_ID,
        statistics_info: {
          comment_count: 123,
          digg_count: 456_789,
          share_count: 321,
        },
        ...overrides,
      },
    ],
  });
}

describe('parseTikTokPlayerResponse', () => {
  it('maps exact public player interaction counters', () => {
    expect(parseTikTokPlayerResponse(response(), VIDEO_ID)).toEqual({
      likes: 456_789,
      comments: 123,
      shares: 321,
    });
  });

  it('accepts digit strings without rounding them', () => {
    const body = response({
      statistics_info: {
        comment_count: '123',
        digg_count: '456789',
        share_count: '321',
      },
    });
    expect(parseTikTokPlayerResponse(body, VIDEO_ID).likes).toBe(456_789);
  });

  it('rejects malformed JSON, missing ids and invalid counters', () => {
    expect(() => parseTikTokPlayerResponse('{bad', VIDEO_ID)).toThrow(TikTokPlayerParseError);
    expect(() => parseTikTokPlayerResponse(response(), '999')).toThrow(/requested id/);
    expect(() =>
      parseTikTokPlayerResponse(
        response({
          statistics_info: { comment_count: 1, digg_count: '12k', share_count: 2 },
        }),
        VIDEO_ID,
      ),
    ).toThrow(/digg_count/);
  });
});
