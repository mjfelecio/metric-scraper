import { ScrapeError } from '../../src/core/models/errors.js';

/**
 * Apify addresses an Actor in a URL path as `owner~name`, not `owner/name`.
 *
 * The conversion is trivial; the validation is not. This string is
 * concatenated into a request path, so anything that could smuggle a path
 * segment, a query string or a different endpoint has to be rejected here
 * rather than discovered as a strange 404 mid-run.
 */
const OWNER_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,62}[a-zA-Z0-9])?$/;

/** A bare technical Actor id, as returned by the API (e.g. `abc123DEFghi456JK`). */
const BARE_ID_PATTERN = /^[a-zA-Z0-9]{5,32}$/;

export interface ParsedActorId {
  /** Exactly what the operator typed, for reports. */
  readonly input: string;
  /** The `owner~name` (or bare id) form that goes into the request path. */
  readonly pathId: string;
}

export function parseActorId(raw: string): ParsedActorId {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ScrapeError({ code: 'config_error', message: 'actor id must not be empty' });
  }

  // Accept both separators so `--actor clockworks~tiktok-scraper` works too, but
  // never both at once: that is a typo, not a second Actor.
  const separators = (trimmed.match(/[/~]/g) ?? []).length;

  if (separators === 0) {
    if (!BARE_ID_PATTERN.test(trimmed)) {
      throw new ScrapeError({
        code: 'config_error',
        message: `invalid actor id "${trimmed}": expected "owner/name" or a bare alphanumeric Actor id`,
      });
    }
    return { input: trimmed, pathId: trimmed };
  }

  if (separators > 1) {
    throw new ScrapeError({
      code: 'config_error',
      message: `invalid actor id "${trimmed}": expected exactly one "/" or "~" separator`,
    });
  }

  const [owner, name] = trimmed.split(/[/~]/) as [string, string];
  if (!OWNER_PATTERN.test(owner) || !OWNER_PATTERN.test(name)) {
    throw new ScrapeError({
      code: 'config_error',
      message:
        `invalid actor id "${trimmed}": owner and name must be alphanumeric ` +
        'with inner dots, dashes or underscores',
    });
  }

  return { input: trimmed, pathId: `${owner}~${name}` };
}
