export class InstagramParseError extends Error {
  override readonly name = 'InstagramParseError';
}

export function parseJson(body: string, source: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new InstagramParseError(`${source} response does not contain valid JSON`);
  }
}

export function parseOptionalCount(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new InstagramParseError(`${field} must be a safe non-negative integer`);
  }
  return numeric;
}

export function parseRequiredCount(value: unknown, field: string): number {
  const count = parseOptionalCount(value, field);
  if (count === null) throw new InstagramParseError(`${field} is required`);
  return count;
}

export function parseTimestamp(value: unknown, field: string): string | null {
  const seconds = parseOptionalCount(value, field);
  if (seconds === null) return null;
  try {
    return new Date(seconds * 1_000).toISOString();
  } catch {
    throw new InstagramParseError(`${field} is outside the supported date range`);
  }
}
