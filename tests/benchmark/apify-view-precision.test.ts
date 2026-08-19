import { describe, expect, it } from 'vitest';

import {
  diagnoseViewPrecision,
  expectedDisplayStep,
  resolutionOf,
} from '../../scripts/apify-comparison/view-precision.js';

describe('expectedDisplayStep', () => {
  it.each([
    [0, 1],
    [9_999, 1],
    // Band edges, which is where an off-by-one would hide.
    [10_000, 100],
    [999_999, 100],
    [1_000_000, 100_000],
    [12_300_000, 100_000],
  ])('maps %i views to a %i step', (value, step) => {
    expect(expectedDisplayStep(value)).toBe(step);
  });
});

describe('resolutionOf', () => {
  it.each([
    [1_234_567, 1],
    [1_234_500, 100],
    [1_200_000, 100_000],
    [0, 1],
    // Capped at 100,000: nothing in this problem needs a finer claim than that.
    [10_000_000, 100_000],
  ])('reports %i as resolving to %i', (value, resolution) => {
    expect(resolutionOf(value)).toBe(resolution);
  });
});

describe('diagnoseViewPrecision', () => {
  it('finds no extra granularity when both sources agree exactly', () => {
    const result = diagnoseViewPrecision(1_200_000, 1_200_000);
    expect(result.apifyMoreGranular).toBe(false);
    expect(result.localLooksQuantized).toBe(true);
  });

  it('flags Apify as more granular inside one rounding step of the local value', () => {
    const result = diagnoseViewPrecision(1_200_000, 1_234_567);
    expect(result.apifyMoreGranular).toBe(true);
    expect(result.localResolution).toBe(100_000);
    expect(result.apifyResolution).toBe(1);
    expect(result.note).toBeNull();
  });

  it('calls a far-apart finer value a disagreement, not added precision', () => {
    const result = diagnoseViewPrecision(1_200_000, 1_930_412);
    expect(result.apifyMoreGranular).toBe(false);
    expect(result.note).toMatch(/disagreement/);
  });

  it('does not claim granularity when Apify is the coarser of the two', () => {
    expect(diagnoseViewPrecision(1_234_567, 1_200_000).apifyMoreGranular).toBe(false);
  });

  it('works in the 100-step band', () => {
    expect(diagnoseViewPrecision(45_600, 45_637).apifyMoreGranular).toBe(true);
    expect(diagnoseViewPrecision(45_600, 45_600).apifyMoreGranular).toBe(false);
  });

  it('makes no claim at all when a source reported nothing', () => {
    const missingApify = diagnoseViewPrecision(1_200_000, null);
    expect(missingApify.apifyMoreGranular).toBeNull();
    expect(missingApify.localResolution).toBe(100_000);
    expect(missingApify.note).toMatch(/Apify did not report/);

    const missingLocal = diagnoseViewPrecision(null, 1_234_567);
    expect(missingLocal.apifyMoreGranular).toBeNull();
    expect(missingLocal.apifyResolution).toBe(1);

    const missingBoth = diagnoseViewPrecision(null, null);
    expect(missingBoth.note).toMatch(/neither source/);
  });
});
