import { describe, expect, it } from 'vitest';

import { loadTargets } from '../../scripts/apify-comparison/load-targets.js';
import { parseInput } from '../../src/core/input/parse-input.js';
import { type ParsedInput } from '../../src/core/models/input.js';
import { type createDefaultUrlNormalizerRegistry } from '../../src/platforms/index.js';

/**
 * Stands in for the filesystem only. The parsing, normalization and platform
 * rules under test are the production ones, which is the point: the benchmark
 * must submit exactly the URLs the real pipeline would have scraped.
 */
function fakeLoader(contents: string) {
  return (
    _path: string,
    options: { registry: ReturnType<typeof createDefaultUrlNormalizerRegistry> },
  ): Promise<ParsedInput> =>
    Promise.resolve(
      parseInput(contents, {
        registry: options.registry,
        format: 'auto',
        expectedPlatform: 'tiktok',
      }),
    );
}

function load(contents: string, maxUrls = 5) {
  return loadTargets('urls.txt', {
    maxUrls,
    loader: fakeLoader(contents),
  });
}

describe('loadTargets', () => {
  it('normalizes URLs and extracts the TikTok video id', async () => {
    const loaded = await load('https://www.tiktok.com/@emrys8473/video/7643585712641559841');

    expect(loaded.targets).toHaveLength(1);
    expect(loaded.targets[0]).toMatchObject({
      videoId: '7643585712641559841',
      url: 'https://www.tiktok.com/@emrys8473/video/7643585712641559841',
      kind: 'video',
      handle: 'emrys8473',
    });
  });

  it('accepts a JSON array as well as newline text', async () => {
    const loaded = await load(
      JSON.stringify([
        'https://www.tiktok.com/@a/video/1111111111111111111',
        'https://www.tiktok.com/@b/video/2222222222222222222',
      ]),
    );
    expect(loaded.targets).toHaveLength(2);
  });

  it('bills the same post once however many query-string variants point at it', async () => {
    const loaded = await load(
      [
        'https://www.tiktok.com/@rides.withme/photo/7623071715257634068',
        'https://www.tiktok.com/@rides.withme/photo/7623071715257634068?is_from_webapp=1&sender_device=pc',
        'https://www.tiktok.com/@rides.withme/photo/7623071715257634068?_r=1',
      ].join('\n'),
    );

    expect(loaded.targets).toHaveLength(1);
    expect(loaded.targets[0]?.kind).toBe('photo');
    // Two collapses, and neither is reported as a rejected input.
    expect(loaded.duplicatesCollapsed).toBe(2);
    expect(loaded.rejected).toHaveLength(0);
  });

  it('collapses the same video id reached through different handles', async () => {
    const loaded = await load(
      [
        'https://www.tiktok.com/@one/video/7643585712641559841',
        'https://www.tiktok.com/@two/video/7643585712641559841',
      ].join('\n'),
    );

    expect(loaded.targets).toHaveLength(1);
    expect(loaded.duplicatesCollapsed).toBe(1);
    expect(loaded.targets[0]?.rawUrls).toHaveLength(2);
  });

  it('rejects non-TikTok URLs as issues rather than paying for them', async () => {
    const loaded = await load(
      [
        'https://www.tiktok.com/@a/video/1111111111111111111',
        'https://www.instagram.com/reel/ABC123/',
      ].join('\n'),
    );

    expect(loaded.targets).toHaveLength(1);
    expect(loaded.rejected).toHaveLength(1);
    expect(loaded.rejected[0]?.code).toBe('platform_mismatch');
  });

  it('refuses a short link instead of resolving it, which would need a request', async () => {
    await expect(load('https://vm.tiktok.com/ZMabcdefg/')).rejects.toThrow(
      /no resolvable TikTok video id/,
    );
  });

  it('refuses rather than silently truncating when over the URL cap', async () => {
    const urls = Array.from(
      { length: 6 },
      (_value, index) => `https://www.tiktok.com/@a/video/111111111111111111${index}`,
    ).join('\n');

    await expect(load(urls, 5)).rejects.toThrow(/over the configured limit of 5/);
  });

  it('counts only unique posts against the cap', async () => {
    const url = 'https://www.tiktok.com/@a/video/1111111111111111111';
    const loaded = await load([url, `${url}?x=1`, `${url}?y=2`].join('\n'), 1);
    expect(loaded.targets).toHaveLength(1);
  });

  it('fails when nothing usable is left', async () => {
    await expect(load('https://www.instagram.com/reel/ABC123/')).rejects.toThrow(
      /no usable TikTok post URLs/,
    );
  });
});
