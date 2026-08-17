import { describe, expect, it } from 'vitest';

import {
  parseTikTokHydrationHtml,
  TikTokHydrationParseError,
} from '../../src/platforms/tiktok/tiktok-hydration-parser.js';

const VIDEO_ID = '7420000000000000001';

function completeItem(): Record<string, unknown> {
  return {
    id: VIDEO_ID,
    createTime: '1700000000',
    stats: {
      playCount: 123_456,
      diggCount: '7890',
      commentCount: 321,
      shareCount: '45',
      collectCount: '678',
    },
    author: { uniqueId: 'bloxclips_creator' },
    authorStats: { followerCount: '98765' },
  };
}

function htmlFor(item: Record<string, unknown>): string {
  const payload = {
    __DEFAULT_SCOPE__: {
      'webapp.video-detail': {
        itemInfo: { itemStruct: item },
      },
    },
  };
  return `<html><script type="application/json" data-test="fixture" id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify(payload)}</script></html>`;
}

function embedHtml(item: Record<string, unknown>): string {
  const payload = {
    source: {
      data: {
        [`/embed/v2/${VIDEO_ID}`]: {
          videoData: {
            itemInfos: item,
            authorInfos: { uniqueId: 'embed_creator' },
            authorStats: { followerCount: '4567' },
          },
        },
      },
    },
  };
  return `<html><script id="__FRONTITY_CONNECT_STATE__" type="application/json">${JSON.stringify(payload)}</script></html>`;
}

describe('parseTikTokHydrationHtml', () => {
  it('maps the live public embed state used for anonymous acquisition', () => {
    const item = {
      id: VIDEO_ID,
      createTime: '1700000000',
      playCount: 123_456,
      diggCount: '7890',
      commentCount: 321,
      shareCount: '45',
    };

    expect(parseTikTokHydrationHtml(embedHtml(item), VIDEO_ID)).toEqual({
      video_id: VIDEO_ID,
      views: 123_456,
      likes: 7_890,
      comments: 321,
      shares: 45,
      saves: null,
      author_handle: 'embed_creator',
      author_follower_count: 4_567,
      posted_at: '2023-11-14T22:13:20.000Z',
    });
  });

  it('maps required and optional metrics from the public hydration payload', () => {
    expect(parseTikTokHydrationHtml(htmlFor(completeItem()), VIDEO_ID)).toEqual({
      video_id: VIDEO_ID,
      views: 123_456,
      likes: 7_890,
      comments: 321,
      shares: 45,
      saves: 678,
      author_handle: 'bloxclips_creator',
      author_follower_count: 98_765,
      posted_at: '2023-11-14T22:13:20.000Z',
    });
  });

  it('allows optional platform fields to be absent', () => {
    const item = completeItem();
    delete item.createTime;
    delete item.author;
    delete item.authorStats;
    const stats = item.stats as Record<string, unknown>;
    delete stats.collectCount;

    const parsed = parseTikTokHydrationHtml(htmlFor(item), VIDEO_ID);
    expect(parsed.saves).toBeNull();
    expect(parsed.author_handle).toBeNull();
    expect(parsed.author_follower_count).toBeNull();
    expect(parsed.posted_at).toBeNull();
  });

  it('finds the script regardless of attribute order and quote style', () => {
    const payload = {
      __DEFAULT_SCOPE__: {
        'webapp.video-detail': { itemInfo: { itemStruct: completeItem() } },
      },
    };
    const html = `<script data-x='1' id='__UNIVERSAL_DATA_FOR_REHYDRATION__' type='application/json'>${JSON.stringify(payload)}</script>`;
    expect(parseTikTokHydrationHtml(html, VIDEO_ID).views).toBe(123_456);
  });

  it('rejects a missing script and malformed JSON', () => {
    expect(() => parseTikTokHydrationHtml('<html></html>', VIDEO_ID)).toThrow(
      TikTokHydrationParseError,
    );
    expect(() =>
      parseTikTokHydrationHtml(
        '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">{bad</script>',
        VIDEO_ID,
      ),
    ).toThrow(/valid JSON/);
  });

  it('rejects a missing required metric', () => {
    const item = completeItem();
    delete (item.stats as Record<string, unknown>).shareCount;
    expect(() => parseTikTokHydrationHtml(htmlFor(item), VIDEO_ID)).toThrow(/shareCount/);
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['malformed string', '12k'],
    ['unsafe integer', '9007199254740992'],
  ])('rejects a %s count', (_label, value) => {
    const item = completeItem();
    (item.stats as Record<string, unknown>).playCount = value;
    expect(() => parseTikTokHydrationHtml(htmlFor(item), VIDEO_ID)).toThrow(/playCount/);
  });

  it('rejects a payload for a different video', () => {
    expect(() => parseTikTokHydrationHtml(htmlFor(completeItem()), '999')).toThrow(
      /does not match requested id/,
    );
  });
});
