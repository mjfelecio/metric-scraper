import { describe, expect, it } from 'vitest';

import { createDefaultUrlNormalizerRegistry } from '../../../src/platforms/index.js';
import {
  generateSyntheticInput,
  instagramSyntheticUrl,
  repeatRecords,
  tiktokSyntheticUrl,
} from '../../../src/stress/workload/synthetic-input.js';

describe('synthetic-input', () => {
  it('TikTok synthetic URLs are accepted, unchanged, by the real normalizer', () => {
    const registry = createDefaultUrlNormalizerRegistry();
    const url = tiktokSyntheticUrl(42);

    const result = registry.normalize(url);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.platform).toBe('tiktok');
      expect(result.requiresResolution).toBe(false);
      expect(result.url).toBe(url);
      expect(result.videoId).toMatch(/^\d+$/);
    }
  });

  it('Instagram synthetic URLs are accepted, unchanged, by the real normalizer', () => {
    const registry = createDefaultUrlNormalizerRegistry();
    const url = instagramSyntheticUrl(42);

    const result = registry.normalize(url);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.platform).toBe('instagram');
      expect(result.requiresResolution).toBe(false);
      expect(result.url).toBe(url);
    }
  });

  it('generateSyntheticInput produces distinct, sequentially-positioned records', () => {
    const records = generateSyntheticInput({ platform: 'tiktok', count: 50 });

    expect(records).toHaveLength(50);
    expect(records.map((record) => record.position)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 1),
    );
    expect(new Set(records.map((record) => record.url)).size).toBe(50);
    expect(records.every((record) => record.platform === 'tiktok')).toBe(true);
  });

  it('generateSyntheticInput(mixed) produces roughly both platforms, not all one', () => {
    const records = generateSyntheticInput({ platform: 'mixed', count: 200 });
    const tiktokCount = records.filter((record) => record.platform === 'tiktok').length;

    expect(tiktokCount).toBeGreaterThan(50);
    expect(tiktokCount).toBeLessThan(150);
  });

  it('startIndex avoids id collisions across phases', () => {
    const phase1 = generateSyntheticInput({ platform: 'tiktok', count: 10, startIndex: 0 });
    const phase2 = generateSyntheticInput({ platform: 'tiktok', count: 10, startIndex: 10 });

    const urls = new Set([...phase1, ...phase2].map((record) => record.url));
    expect(urls.size).toBe(20);
  });

  it('repeatRecords renumbers positions contiguously across passes', () => {
    const base = generateSyntheticInput({ platform: 'tiktok', count: 20 });

    const repeated = repeatRecords(base, 3);

    expect(repeated).toHaveLength(60);
    expect(repeated.map((record) => record.position)).toEqual(
      Array.from({ length: 60 }, (_, index) => index + 1),
    );
    // Each of the 20 URLs appears exactly 3 times.
    const counts = new Map<string, number>();
    for (const record of repeated) counts.set(record.url, (counts.get(record.url) ?? 0) + 1);
    expect([...counts.values()].every((count) => count === 3)).toBe(true);
  });
});
