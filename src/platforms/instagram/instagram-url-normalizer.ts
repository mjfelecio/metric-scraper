import { type Platform } from '../../core/models/platform.js';
import { hostMatches, normalizeUrlGeneric } from '../../core/url/generic.js';
import { type UrlNormalizationResult, type UrlNormalizer } from '../../core/url/types.js';

import { shortcodeToMediaId } from './instagram-shortcode.js';

const INSTAGRAM_DOMAIN = 'instagram.com';

const POST_PATH = /^\/(reel|reels|p|tv)\/([A-Za-z0-9_-]+)\/?$/;

/** Canonicalizes supported Instagram Reel and video-post URLs. */
export class InstagramUrlNormalizer implements UrlNormalizer {
  readonly platform: Platform = 'instagram';

  matches(url: URL): boolean {
    return hostMatches(url, INSTAGRAM_DOMAIN);
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
