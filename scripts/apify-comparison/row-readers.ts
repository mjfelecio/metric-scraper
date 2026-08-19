/**
 * Primitives shared by every Actor adapter.
 *
 * These live in one place on purpose. Each adapter reads a different vendor's
 * output shape, but they must all answer "is this a usable number?" the same
 * way — if one adapter quietly accepted `-1` or coerced a missing field to `0`
 * while another returned `null`, the benchmark would report a difference
 * between two TikTok sources that was really a difference between two of our
 * own parsers. That is the one bug this whole experiment cannot afford.
 */

/**
 * A count, or `null`.
 *
 * Accepts the numeric strings TikTok payloads sometimes carry, and rejects
 * everything else — including `NaN`, negatives and non-integers. Absence and
 * malformation are the same answer here: we do not know.
 *
 * Never returns `0` for a missing field. A zero would silently claim the post
 * has no views, the single most damaging thing this benchmark could get wrong.
 */
export function count(...candidates: readonly unknown[]): number | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'number') {
      if (Number.isSafeInteger(candidate) && candidate >= 0) return candidate;
      continue;
    }
    if (typeof candidate === 'string' && /^\d+$/.test(candidate.trim())) {
      const parsed = Number(candidate.trim());
      if (Number.isSafeInteger(parsed)) return parsed;
    }
  }
  return null;
}

/** The first non-blank string among the candidates, trimmed, or `null`. */
export function firstString(...candidates: readonly unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim();
  }
  return null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A TikTok epoch timestamp as ISO-8601, or `null`.
 *
 * TikTok's `create_time` / `createTime` is in seconds; a value large enough to
 * be milliseconds is treated as such rather than being read as a date in the
 * year 50,000.
 */
export function epochToIso(value: unknown): string | null {
  const epoch = count(value);
  if (epoch === null || epoch <= 0) return null;
  const ms = epoch > 1e12 ? epoch : epoch * 1_000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
