/**
 * Generic, platform-agnostic URL canonicalization.
 *
 * Everything in here is safe regardless of how TikTok or Instagram actually
 * behave. Platform-specific rules (short-link resolution, which query
 * parameters are load-bearing, how an id is embedded in a path) belong in the
 * per-platform normalizers and must be verified before being added.
 */

/**
 * Query parameters stripped from every URL. These are cross-web marketing /
 * click-tracking parameters, not platform routing parameters.
 */
export const GENERIC_TRACKING_PARAMS: readonly string[] = [
  'gclid',
  'dclid',
  'fbclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'yclid',
  '_ga',
];

const GENERIC_TRACKING_PREFIXES: readonly string[] = ['utm_'];

export interface GenericNormalizeOptions {
  /** Extra parameter names to drop, contributed by a platform normalizer. */
  extraTrackingParams?: readonly string[] | undefined;
  /**
   * When true, all query parameters are dropped. Off by default: we do not yet
   * know which parameters either platform needs.
   */
  dropAllQueryParams?: boolean | undefined;
}

export type GenericNormalizeResult =
  { ok: true; url: URL; changed: boolean } | { ok: false; message: string };

function isTrackingParam(name: string, extra: readonly string[]): boolean {
  const lower = name.toLowerCase();
  if (GENERIC_TRACKING_PARAMS.includes(lower)) return true;
  if (extra.includes(lower)) return true;
  return GENERIC_TRACKING_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Applies only reversible, semantics-preserving transformations:
 *
 * - trims surrounding whitespace
 * - assumes `https://` when no scheme is present (common in pasted lists)
 * - rejects non-http(s) schemes
 * - lowercases the host and drops a trailing dot and the default port (via `URL`)
 * - drops the fragment (never sent to the server)
 * - drops known tracking parameters
 * - sorts the remaining query parameters so equivalent URLs de-duplicate
 *
 * The path is left untouched — including any trailing slash — because path
 * rewriting is where unverified platform assumptions creep in.
 */
export function normalizeUrlGeneric(
  raw: string,
  options: GenericNormalizeOptions = {},
): GenericNormalizeResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: 'URL is empty' };
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, message: `not a parseable URL: ${truncate(trimmed)}` };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, message: `unsupported scheme "${url.protocol.replace(':', '')}"` };
  }

  if (url.hostname.length === 0) {
    return { ok: false, message: `URL has no host: ${truncate(trimmed)}` };
  }

  // `new URL` already lowercases the host and removes a default port.
  if (url.hostname.endsWith('.')) {
    url.hostname = url.hostname.slice(0, -1);
  }

  url.hash = '';

  const extra = (options.extraTrackingParams ?? []).map((name) => name.toLowerCase());
  if (options.dropAllQueryParams === true) {
    url.search = '';
  } else {
    for (const name of [...url.searchParams.keys()]) {
      if (isTrackingParam(name, extra)) {
        url.searchParams.delete(name);
      }
    }
    url.searchParams.sort();
  }

  return { ok: true, url, changed: url.toString() !== trimmed };
}

export function truncate(value: string, max = 120): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Host matching that accepts subdomains but never a suffix collision
 * (`nottiktok.com` does not match `tiktok.com`).
 */
export function hostMatches(url: URL, domain: string): boolean {
  const host = url.hostname.toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
}
