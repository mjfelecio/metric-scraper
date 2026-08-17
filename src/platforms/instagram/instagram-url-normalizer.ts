import { type Platform } from '../../core/models/platform.js';
import { hostMatches, normalizeUrlGeneric } from '../../core/url/generic.js';
import { type UrlNormalizationResult, type UrlNormalizer } from '../../core/url/types.js';

const INSTAGRAM_DOMAIN = 'instagram.com';

/**
 * Instagram URL canonicalization.
 *
 * Currently generic-only. The platform-specific work that belongs here once
 * acquisition is investigated:
 *
 * - the relationship between the `/reel/<code>` and `/p/<code>` forms (the two
 *   post shapes this project targets) and whether they are interchangeable
 * - deriving a stable native id from the URL shortcode
 * - which query parameters are load-bearing versus share tracking
 *
 * The shortcode in the path is deliberately NOT treated as `video_id`: whether
 * it is the platform's own identifier has not been verified, and putting a
 * guess into an append-only dataset is worse than leaving the field null.
 */
export class InstagramUrlNormalizer implements UrlNormalizer {
  readonly platform: Platform = 'instagram';

  matches(url: URL): boolean {
    return hostMatches(url, INSTAGRAM_DOMAIN);
  }

  normalize(raw: string): UrlNormalizationResult {
    const generic = normalizeUrlGeneric(raw, {
      // TODO(acquisition): add Instagram's own share/tracking parameters here
      // once it is verified which ones are safe to drop.
      extraTrackingParams: [],
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

    return {
      ok: true,
      url: generic.url.toString(),
      platform: this.platform,
      videoId: null,
      // No Instagram short-link form is treated as verified, so nothing here
      // claims to need resolution yet.
      requiresResolution: false,
      changed: generic.changed,
    };
  }
}
