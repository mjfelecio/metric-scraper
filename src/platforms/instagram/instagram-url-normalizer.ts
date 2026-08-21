import { type Platform } from '../../core/models/platform.js';
import { hostMatches, normalizeUrlGeneric } from '../../core/url/generic.js';
import { type UrlNormalizationResult, type UrlNormalizer } from '../../core/url/types.js';

import { shortcodeToMediaId } from './instagram-shortcode.js';

const INSTAGRAM_DOMAIN = 'instagram.com';
const LEGACY_INSTAGRAM_DOMAIN = 'instagr.am';

const POST_PATH = /^\/(reel|reels|p|tv)\/([A-Za-z0-9_-]+)\/?$/;
const SHARE_PATH = /^\/share\/(?:(?:reel|p)\/)?([A-Za-z0-9_-]+)\/?$/;

/** Canonicalizes supported Instagram Reel and video-post URLs. */
export class InstagramUrlNormalizer implements UrlNormalizer {
  readonly platform: Platform = 'instagram';

  matches(url: URL): boolean {
    return hostMatches(url, INSTAGRAM_DOMAIN) || hostMatches(url, LEGACY_INSTAGRAM_DOMAIN);
  }

  normalize(raw: string): UrlNormalizationResult {
    const generic = normalizeUrlGeneric(raw, {
      extraTrackingParams: ['igsh', 'igshid'],
    });

    if (!generic.ok) {
      return { ok: false, code: 'invalid_url', message: generic.message };
    }
    if (!this.matches(generic.url)) {
      return {
        ok: false,
        code: 'unsupported_platform',
        message: `host "${generic.url.hostname}" is not an Instagram URL`,
      };
    }

    const legacyShortLink = hostMatches(generic.url, LEGACY_INSTAGRAM_DOMAIN);
    const shareLink =
      hostMatches(generic.url, INSTAGRAM_DOMAIN) && SHARE_PATH.test(generic.url.pathname);

    if (legacyShortLink || shareLink) {
      const shortUrl = canonicalShortUrl(generic.url, legacyShortLink);
      if (shortUrl === null) {
        return {
          ok: false,
          code: 'invalid_url',
          message:
            'Instagram short links must use /share/{token}, /share/reel/{token}, /share/p/{token}, or an instagr.am post path',
        };
      }
      return {
        ok: true,
        url: shortUrl,
        platform: this.platform,
        videoId: null,
        requiresResolution: true,
        changed: generic.changed || shortUrl !== generic.url.toString(),
      };
    }

    const path = POST_PATH.exec(generic.url.pathname);
    if (path === null) {
      return {
        ok: false,
        code: 'invalid_url',
        message:
          'Instagram scraper supports /reel/{shortcode}, /reels/{shortcode}, /p/{shortcode}, and /tv/{shortcode} URLs',
      };
    }

    const rawKind = path[1];
    const shortcode = path[2];
    if (rawKind === undefined || shortcode === undefined) {
      return { ok: false, code: 'invalid_url', message: 'Instagram URL is missing a shortcode' };
    }
    const kind = rawKind === 'reels' ? 'reel' : rawKind;
    const canonical = `https://www.instagram.com/${kind}/${shortcode}/`;

    return {
      ok: true,
      url: canonical,
      platform: this.platform,
      videoId: shortcodeToMediaId(shortcode),
      requiresResolution: false,
      changed: generic.changed || canonical !== generic.url.toString(),
    };
  }
}

function canonicalShortUrl(url: URL, legacy: boolean): string | null {
  if (legacy) {
    const match = POST_PATH.exec(url.pathname);
    const kind = match?.[1];
    const shortcode = match?.[2];
    if (kind === undefined || shortcode === undefined) return null;
    return `https://instagr.am/${kind}/${shortcode}/`;
  }

  const match = SHARE_PATH.exec(url.pathname);
  if (match === null) return null;
  const segments = url.pathname.split('/').filter(Boolean);
  const token = segments.at(-1);
  if (token === undefined) return null;
  const kind = segments.length === 3 ? `/${segments[1]}` : '';
  return `https://www.instagram.com/share${kind}/${token}/`;
}

export interface ParsedInstagramUrl {
  shortcode: string;
  mediaId: string;
  kind: 'reel' | 'p' | 'tv';
}

export function parseCanonicalInstagramUrl(raw: string): ParsedInstagramUrl | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!hostMatches(url, INSTAGRAM_DOMAIN)) return null;
  const match = /^\/(reel|p|tv)\/([A-Za-z0-9_-]+)\/$/.exec(url.pathname);
  const kind = match?.[1];
  const shortcode = match?.[2];
  if ((kind !== 'reel' && kind !== 'p' && kind !== 'tv') || shortcode === undefined) return null;
  return { shortcode, mediaId: shortcodeToMediaId(shortcode), kind };
}
