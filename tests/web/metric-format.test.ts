import { describe, expect, it } from 'vitest';

import { type MetricPointDto } from '../../src/app/types.js';
import {
  formatBytes,
  formatCompact,
  formatDelta,
  formatExact,
  toPlotPoints,
} from '../../src/web/metric-format.js';

function point(
  cycle: number,
  metrics: Partial<Pick<MetricPointDto, 'views' | 'likes' | 'comments' | 'shares'>>,
  status: MetricPointDto['status'] = 'ok',
): MetricPointDto {
  return {
    cycle,
    at: new Date(Date.UTC(2026, 7, 19, 16, 40 + cycle, 0)).toISOString(),
    status,
    views: null,
    likes: null,
    comments: null,
    shares: null,
    ...metrics,
  };
}

describe('formatCompact', () => {
  it('abbreviates only above a thousand', () => {
    expect(formatCompact(12)).toBe('12');
    expect(formatCompact(128)).toBe('128');
    expect(formatCompact(999)).toBe('999');
    expect(formatCompact(0)).toBe('0');
  });

  it('uses one decimal with a unit suffix', () => {
    expect(formatCompact(1_547)).toBe('1.5K');
    expect(formatCompact(10_300)).toBe('10.3K');
    expect(formatCompact(153_247)).toBe('153.2K');
    expect(formatCompact(1_500_000)).toBe('1.5M');
    expect(formatCompact(2_400_000_000)).toBe('2.4B');
  });

  it('trims a trailing .0 rather than printing 12.0K', () => {
    expect(formatCompact(12_000)).toBe('12K');
    expect(formatCompact(1_000_000)).toBe('1M');
  });

  it('truncates rather than rounding, so a label never overstates the value', () => {
    // 153,299 must not read as 153.3K.
    expect(formatCompact(153_299)).toBe('153.2K');
    expect(formatCompact(1_999)).toBe('1.9K');
  });
});

describe('formatBytes', () => {
  it('stays in bytes below 1000', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
  });

  it('uses one decimal with a unit suffix at each threshold', () => {
    expect(formatBytes(1_000)).toBe('1.0 KB');
    expect(formatBytes(1_433_600)).toBe('1.4 MB');
    expect(formatBytes(2_400_000_000)).toBe('2.4 GB');
  });

  it('signs negative values', () => {
    expect(formatBytes(-1_500)).toBe('-1.5 KB');
  });

  /**
   * Minor #1: the unit was chosen from the *unrounded* magnitude, so a value
   * that rounds up to exactly 1000.0 at its own unit never got promoted to
   * the next one — `formatBytes(999_999)` used to return `"1000.0 KB"`
   * instead of `"1.0 MB"`.
   */
  it('promotes a value that rounds up to 1000.0 at its own unit to the next unit, rather than printing a 1000.0 mantissa', () => {
    expect(formatBytes(999_999)).toBe('1.0 MB');
    expect(formatBytes(999_999_999)).toBe('1.0 GB');
  });

  it('does not promote a value that rounds to just under 1000.0', () => {
    expect(formatBytes(999_949)).toBe('999.9 KB');
    expect(formatBytes(999_949_999)).toBe('999.9 MB');
  });

  it('has no unit above GB to promote to, so a huge value still reports in GB', () => {
    expect(formatBytes(999_999_999_999)).toBe('1000.0 GB');
  });

  it('promotes right at the boundary where rounding first reaches 1000.0', () => {
    // 999_950 / 1000 = 999.95 -> rounds to 1000.0 at KB, must promote to MB.
    expect(formatBytes(999_950)).toBe('1.0 MB');
    // One byte below that must not promote.
    expect(formatBytes(999_949)).toBe('999.9 KB');
  });
});

describe('formatExact', () => {
  it('preserves the underlying integer with no rounding', () => {
    expect(formatExact(153_247)).toBe('153,247');
    expect(formatExact(8_341)).toBe('8,341');
    expect(formatExact(214)).toBe('214');
  });
});

describe('formatDelta', () => {
  it('signs the change explicitly', () => {
    expect(formatDelta(8_420)).toBe('+8,420');
    expect(formatDelta(-12)).toBe('-12');
    expect(formatDelta(0)).toBe('+0');
  });
});

describe('toPlotPoints', () => {
  const series = [
    point(1, { views: 145_000, likes: 8_324 }),
    point(2, { views: 148_500, likes: 8_330 }),
    point(3, { views: 153_247, likes: 8_341 }),
  ];

  it('does not report a change for the first cycle', () => {
    expect(toPlotPoints(series, 'views')[0]?.delta).toBeNull();
  });

  it('computes the difference from the previous cycle', () => {
    const points = toPlotPoints(series, 'views');
    expect(points[1]?.delta).toBe(3_500);
    expect(points[2]?.delta).toBe(4_747);
  });

  it('preserves the exact scraped values', () => {
    expect(toPlotPoints(series, 'views').map((p) => p.value)).toEqual([145_000, 148_500, 153_247]);
  });

  it('selects the requested metric', () => {
    expect(toPlotPoints(series, 'likes').map((p) => p.value)).toEqual([8_324, 8_330, 8_341]);
    expect(toPlotPoints(series, 'comments').map((p) => p.value)).toEqual([null, null, null]);
  });

  it('keeps the cycle number alongside each point', () => {
    expect(toPlotPoints(series, 'views').map((p) => p.cycle)).toEqual([1, 2, 3]);
  });

  it('measures across a failed cycle rather than inventing a jump', () => {
    const withGap = [
      point(1, { views: 1_000 }),
      point(2, { views: null }, 'rate_limited'),
      point(3, { views: 1_042 }),
    ];
    const points = toPlotPoints(withGap, 'views');

    expect(points[1]?.value).toBeNull();
    expect(points[1]?.delta).toBeNull();
    // Against cycle 1, the last cycle that actually had a value — not against zero.
    expect(points[2]?.delta).toBe(42);
  });

  it('reports no change until some earlier cycle had a value', () => {
    const points = toPlotPoints(
      [point(1, { views: null }, 'error'), point(2, { views: 7 })],
      'views',
    );
    expect(points[1]?.delta).toBeNull();
  });
});
