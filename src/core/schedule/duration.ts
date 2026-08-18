import { ScrapeError } from '../models/errors.js';

/**
 * Human-friendly duration parsing, shared by the CLI, the run config and the
 * dashboard.
 *
 * A bare number is milliseconds, so `--interval 0` (back-to-back) and
 * `--interval 500` both work without a suffix. Everything else carries a unit,
 * because `--interval 15` silently meaning 15 ms would be a trap.
 */

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
};

const PATTERN = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i;

/** Parses `0`, `500`, `500ms`, `30s`, `15m`, `2h` into milliseconds. */
export function parseDuration(value: string): number {
  const trimmed = value.trim().toLowerCase();
  const match = PATTERN.exec(trimmed);
  if (match === null) {
    throw new ScrapeError({
      code: 'config_error',
      message: `invalid duration "${value}" — expected a number optionally followed by ms/s/m/h`,
    });
  }

  const amount = Number(match[1]);
  const unit = match[2] ?? '';
  if (!Number.isFinite(amount) || amount < 0) {
    throw new ScrapeError({
      code: 'config_error',
      message: `invalid duration "${value}" — must be a non-negative number`,
    });
  }

  // No unit means milliseconds, which keeps `0` and raw millisecond values
  // working the same way they do everywhere else in the config.
  if (unit.length === 0) return Math.round(amount);

  const multiplier = UNIT_MS[unit];
  if (multiplier === undefined) {
    throw new ScrapeError({
      code: 'config_error',
      message: `invalid duration "${value}" — unknown unit "${unit}", expected one of ms, s, m, h`,
    });
  }

  return Math.round(amount * multiplier);
}

/** `0` → `0s`, `95000` → `1m35s`, `5400000` → `1h30m`. Inverse-ish of `parseDuration`. */
export function formatDuration(totalMs: number): string {
  if (!Number.isFinite(totalMs) || totalMs <= 0) return '0s';

  const ms = Math.round(totalMs);
  if (ms < 1_000) return `${ms}ms`;

  const totalSeconds = Math.round(ms / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return minutes === 0 ? `${hours}h` : `${hours}h${minutes}m`;
  if (minutes > 0) return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
  return `${seconds}s`;
}
