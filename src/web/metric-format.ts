import { type MetricPointDto } from '../app/types.js';

/**
 * Presentation rules for the metric time series.
 *
 * Kept out of `render.ts` deliberately: formatting and delta arithmetic are the
 * parts that have to be exactly right, and here they are testable without a DOM.
 */

export const METRIC_KEYS = ['views', 'likes', 'comments', 'shares'] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export const METRIC_LABELS: Record<MetricKey, string> = {
  views: 'Views',
  likes: 'Likes',
  comments: 'Comments',
  shares: 'Shares',
};

const UNITS = [
  { threshold: 1_000_000_000, suffix: 'B' },
  { threshold: 1_000_000, suffix: 'M' },
  { threshold: 1_000, suffix: 'K' },
] as const;

/**
 * Abbreviated form for axis labels, e.g. `153.2K`.
 *
 * Truncates rather than rounds, so a label can never claim a value the data does
 * not support: 153,299 reads as `153.2K`, never `153.3K`. This is a *display*
 * transform only — the exact integer is always available in the tooltip.
 */
export function formatCompact(value: number): string {
  const magnitude = Math.abs(value);
  const sign = value < 0 ? '-' : '';

  for (const { threshold, suffix } of UNITS) {
    if (magnitude >= threshold) {
      // One decimal, truncated toward zero.
      const scaled = Math.floor((magnitude / threshold) * 10) / 10;
      return `${sign}${String(scaled)}${suffix}`;
    }
  }

  return `${sign}${String(magnitude)}`;
}

/** The underlying integer, grouped. Tooltips only — never an axis. */
export function formatExact(value: number): string {
  return value.toLocaleString('en-US');
}

/** Signed change against the previous cycle, e.g. `+8,420`. */
export function formatDelta(value: number): string {
  return `${value >= 0 ? '+' : '-'}${formatExact(Math.abs(value))}`;
}

export interface MetricPlotPoint {
  cycle: number;
  /** Epoch ms, for the x scale. */
  tMs: number;
  at: string;
  status: MetricPointDto['status'];
  /** `null` when this cycle produced no value — the line breaks here. */
  value: number | null;
  /** Change from the previous cycle that had a value; `null` when there is none. */
  delta: number | null;
}

/**
 * Projects the series onto one metric and computes per-cycle changes.
 *
 * The delta is measured against the last cycle that actually *had* a value, not
 * simply the previous array element. A cycle that failed therefore does not
 * invent a jump on the cycle after it, which matters because reading jumps is
 * the reason this chart exists.
 */
export function toPlotPoints(
  series: readonly MetricPointDto[],
  metric: MetricKey,
): MetricPlotPoint[] {
  let previous: number | null = null;

  return series.map((point) => {
    const value = point[metric];
    const delta = value === null || previous === null ? null : value - previous;
    if (value !== null) previous = value;

    return {
      cycle: point.cycle,
      tMs: Date.parse(point.at),
      at: point.at,
      status: point.status,
      value,
      delta,
    };
  });
}

const BYTE_UNITS = [
  { threshold: 1_000_000_000, suffix: 'GB' },
  { threshold: 1_000_000, suffix: 'MB' },
  { threshold: 1_000, suffix: 'KB' },
] as const;

/**
 * Human-scaled byte figure, e.g. `1.4 MB`.
 *
 * Decimal (1000-based) units, not binary (1024-based) ones: proxies bill by
 * the decimal byte, and this figure exists to predict that bill.
 */
export function formatBytes(value: number): string {
  const magnitude = Math.abs(value);
  const sign = value < 0 ? '-' : '';

  for (let i = 0; i < BYTE_UNITS.length; i += 1) {
    const unit = BYTE_UNITS[i];
    if (unit === undefined || magnitude < unit.threshold) continue;

    const rounded = Math.round((magnitude / unit.threshold) * 10) / 10;
    // The unit was chosen from the *unrounded* magnitude, so rounding to one
    // decimal can still carry the value across the next unit's boundary
    // (999,999 -> naive "1000.0 KB"). Re-express with the unit one size up
    // rather than ever displaying a mantissa of 1000.
    const bigger = BYTE_UNITS[i - 1];
    if (bigger !== undefined && rounded >= 1000) {
      return `${sign}${(magnitude / bigger.threshold).toFixed(1)} ${bigger.suffix}`;
    }
    return `${sign}${rounded.toFixed(1)} ${unit.suffix}`;
  }

  return `${sign}${String(magnitude)} B`;
}

/** `Aug 19, 2026 16:42:18` — the tooltip's timestamp. */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/** `16:42:18` — concise enough to sit under an axis tick. */
export function formatClock(tMs: number): string {
  const date = new Date(tMs);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}
