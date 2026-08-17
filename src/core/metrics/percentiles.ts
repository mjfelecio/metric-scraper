/**
 * Nearest-rank percentiles.
 *
 * Chosen over interpolation because latency percentiles are reported to humans
 * and a p95 that equals an observed sample is easier to reason about. The
 * method is stated in the README so the numbers are reproducible.
 */
export function percentileOfSorted(sorted: readonly number[], percentile: number): number | null {
  if (sorted.length === 0) return null;
  if (percentile <= 0) return sorted[0] ?? null;
  if (percentile >= 100) return sorted[sorted.length - 1] ?? null;

  const rank = Math.ceil((percentile / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? null;
}

export function percentile(values: readonly number[], p: number): number | null {
  return percentileOfSorted(
    [...values].sort((a, b) => a - b),
    p,
  );
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

export function max(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce(
    (highest, value) => (value > highest ? value : highest),
    values[0] as number,
  );
}
