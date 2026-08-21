import { describe, expect, it } from 'vitest';

import {
  hashToUnitInterval,
  pickInstagramMatchLocation,
  pickLatencyMs,
  pickTikTokScenario,
  pickWeighted,
} from '../../../src/stress/workload/scenario.js';

describe('hashToUnitInterval', () => {
  it('is deterministic: same seed and key always produce the same value', () => {
    const a = hashToUnitInterval(7, 'tiktok:1');
    const b = hashToUnitInterval(7, 'tiktok:1');
    expect(a).toBe(b);
  });

  it('varies with seed, holding the key fixed', () => {
    const values = new Set(
      Array.from({ length: 8 }, (_, seed) => hashToUnitInterval(seed, 'same-key')),
    );
    expect(values.size).toBeGreaterThan(1);
  });

  it('varies across keys that differ only in a trailing digit (the regression this guards)', () => {
    const values = new Set(
      Array.from({ length: 20 }, (_, index) =>
        hashToUnitInterval(42, `tiktok:700000000000001${index}`).toFixed(3),
      ),
    );
    expect(values.size).toBeGreaterThan(10);
  });

  it('always lands in [0, 1)', () => {
    for (let index = 0; index < 100; index += 1) {
      const value = hashToUnitInterval(1, `key-${index}`);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('pickWeighted', () => {
  it('respects the boundary: unit 0 picks the first positive bucket, unit just under 1 picks the last', () => {
    expect(pickWeighted(0, { a: 1, b: 1, c: 1 })).toBe('a');
    expect(pickWeighted(0.9999, { a: 1, b: 1, c: 1 })).toBe('c');
  });

  it('skips zero/negative-weight buckets entirely', () => {
    for (let unit = 0; unit < 1; unit += 0.05) {
      expect(pickWeighted(unit, { a: 0, b: 1, c: -5 })).toBe('b');
    }
  });

  it('throws when every weight is non-positive', () => {
    expect(() => pickWeighted(0.5, { a: 0, b: -1 })).toThrow(/no positive/);
  });

  it('approximates the configured proportions over many draws', () => {
    let a = 0;
    let c = 0;
    const draws = 5_000;
    for (let index = 0; index < draws; index += 1) {
      const key = pickWeighted(hashToUnitInterval(1, `draw:${index}`), { a: 70, b: 20, c: 10 });
      if (key === 'a') a += 1;
      else if (key === 'c') c += 1;
    }
    expect(a / draws).toBeGreaterThan(0.6);
    expect(a / draws).toBeLessThan(0.8);
    expect(c / draws).toBeGreaterThan(0.03);
    expect(c / draws).toBeLessThan(0.2);
  });
});

describe('pickTikTokScenario', () => {
  it('is a pure function of (seed, id): repeated calls agree', () => {
    const weights = { normal: 50, embed_403: 50 };
    const first = pickTikTokScenario('7000000000000001', weights, 5);
    const second = pickTikTokScenario('7000000000000001', weights, 5);
    expect(first).toBe(second);
  });
});

describe('pickInstagramMatchLocation', () => {
  it('returns a fixed location for clips_page1/clips_page2', () => {
    expect(pickInstagramMatchLocation('900000000001', 'clips_page1', 1, 3, 2)).toEqual({
      authorIndex: 0,
      page: 1,
    });
    expect(pickInstagramMatchLocation('900000000001', 'clips_page2', 1, 3, 2)).toEqual({
      authorIndex: 0,
      page: 2,
    });
  });

  it('returns null for scenarios that never find a match', () => {
    expect(pickInstagramMatchLocation('900000000001', 'fast_path', 1, 3, 2)).toBeNull();
    expect(pickInstagramMatchLocation('900000000001', 'clips_exhausted', 1, 3, 2)).toBeNull();
    expect(pickInstagramMatchLocation('900000000001', 'post_500', 1, 3, 2)).toBeNull();
  });

  it('clips_deep never lands on the first author (that would just be clips_page1/2)', () => {
    for (let index = 0; index < 30; index += 1) {
      const location = pickInstagramMatchLocation(`shortcode-${index}`, 'clips_deep', 9, 3, 2);
      expect(location).not.toBeNull();
      expect(location?.authorIndex).toBeGreaterThan(0);
      expect(location?.authorIndex).toBeLessThan(3);
      expect(location?.page).toBeGreaterThanOrEqual(1);
      expect(location?.page).toBeLessThanOrEqual(2);
    }
  });
});

describe('pickLatencyMs', () => {
  it('stays within [minMs, maxMs]', () => {
    for (let index = 0; index < 50; index += 1) {
      const delay = pickLatencyMs(1, `key-${index}`, { minMs: 100, maxMs: 300 });
      expect(delay).toBeGreaterThanOrEqual(100);
      expect(delay).toBeLessThanOrEqual(300);
    }
  });

  it('collapses to minMs when the range is degenerate', () => {
    expect(pickLatencyMs(1, 'k', { minMs: 50, maxMs: 50 })).toBe(50);
    expect(pickLatencyMs(1, 'k', { minMs: 50, maxMs: 10 })).toBe(50);
  });
});
