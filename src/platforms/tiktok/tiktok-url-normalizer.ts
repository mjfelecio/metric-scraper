import { type Platform } from '../../core/models/platform.js';
import { hostMatches, normalizeUrlGeneric } from '../../core/url/generic.js';
import { type UrlNormalizationResult, type UrlNormalizer } from '../../core/url/types.js';

const TIKTOK_DOMAIN = 'tiktok.com';
const CANONICAL_HOST = 'www.tiktok.com';
const SHORT_LINK_HOSTS = new Set(['vm.tiktok.com', 'vt.tiktok.com']);

export interface CanonicalTikTokVideo {
  handle: string;
  kind: 'video' | 'photo';
  videoId: string;
}

/**
 * Canonicalizes TikTok video/photo post URLs and extracts the platform-native id.
 * Short links remain recognizable so the asynchronous preparation stage can
 * resolve them without making this normalizer impure.
 */
export class TikTokUrlNormalizer implements UrlNormalizer {
  readonly platform: Platform = 'tiktok';

  matches(url: URL): boolean {
    return hostMatches(url, TIKTOK_DOMAIN);
  }

  normalize(raw: string): UrlNormalizationResult {
    const generic = normalizeUrlGeneric(raw, {
      // Canonical post routing is path-based. Query parameters on shared
      // post URLs are attribution/tracking data and are not required.
      dropAllQueryParams: true,
    });

    if (!generic.ok) {
      return { ok: false, code: 'invalid_url', message: generic.message };
    }
    if (!this.matches(generic.url)) {
      return {
        ok: false,
        code: 'unsupported_platform',
        message: `host "${generic.url.hostname}" is not a TikTok URL`,
      };
    }

    if (SHORT_LINK_HOSTS.has(generic.url.hostname)) {
      return {
        ok: true,
        url: generic.url.toString(),
        platform: this.platform,
        videoId: null,
        requiresResolution: true,
        changed: generic.changed,
      };
    }

    const canonical = parseCanonicalTikTokUrl(generic.url);
    if (canonical === null) {
      return {
        ok: false,
        code: 'invalid_url',
        message:
          'TikTok URL must use the /@handle/video/{numeric-id} or /@handle/photo/{numeric-id} format',
      };
    }

    const normalized = new URL(generic.url);
    normalized.protocol = 'https:';
    normalized.hostname = CANONICAL_HOST;
    normalized.port = '';
    normalized.pathname = `/@${canonical.handle}/${canonical.kind}/${canonical.videoId}`;
    normalized.search = '';
    normalized.hash = '';

    return {
      ok: true,
      url: normalized.toString(),
      platform: this.platform,
      videoId: canonical.videoId,
      requiresResolution: false,
      changed: normalized.toString() !== raw.trim(),
    };
  }
}

/** Extracts identity only from TikTok's verified canonical post paths. */
export function parseCanonicalTikTokUrl(url: URL | string): CanonicalTikTokVideo | null {
  let parsed: URL;
  try {
    parsed = typeof url === 'string' ? new URL(url) : url;
  } catch {
    return null;
  }

  if (!hostMatches(parsed, TIKTOK_DOMAIN) || SHORT_LINK_HOSTS.has(parsed.hostname)) {
    return null;
  }

  const match = /^\/@([^/]+)\/(video|photo)\/(\d+)\/?$/.exec(parsed.pathname);
  if (match === null) return null;

  const handle = match[1];
  const kind = match[2];
  const videoId = match[3];
  if (handle === undefined || (kind !== 'video' && kind !== 'photo') || videoId === undefined) {
    return null;
  }
  return { handle, kind, videoId };
}
