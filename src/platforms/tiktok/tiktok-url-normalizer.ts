import { type Platform } from '../../core/models/platform.js';
import { hostMatches, normalizeUrlGeneric } from '../../core/url/generic.js';
import { type UrlNormalizationResult, type UrlNormalizer } from '../../core/url/types.js';

const TIKTOK_DOMAIN = 'tiktok.com';

/**
 * Hosts that serve short/redirect links rather than a canonical post URL.
 *
 * These are recognised so the pipeline can flag "this needs resolving", but
 * nothing here follows a redirect: what the redirect chain looks like, and
 * whether following it is enough to reach a canonical URL, is part of the
 * acquisition research that has not been done yet.
 */
const SHORT_LINK_HOSTS = new Set(['vm.tiktok.com', 'vt.tiktok.com']);

/**
 * TikTok URL canonicalization.
 *
 * Currently generic-only. The platform-specific work that belongs here once
 * acquisition is investigated:
 *
 * - resolving `vm.tiktok.com` / `vt.tiktok.com` short links to a canonical URL
 * - extracting the native video id from the canonical path
 * - deciding which query parameters TikTok actually needs (the rest can be
 *   dropped, which improves de-duplication)
 *
 * None of that is guessed here: an incorrect id would put fabricated values
 * into an append-only dataset.
 */
export class TikTokUrlNormalizer implements UrlNormalizer {
  readonly platform: Platform = 'tiktok';

  matches(url: URL): boolean {
    return hostMatches(url, TIKTOK_DOMAIN);
  }

  normalize(raw: string): UrlNormalizationResult {
    const generic = normalizeUrlGeneric(raw, {
      // TODO(acquisition): add TikTok's own tracking parameters here once it is
      // verified which ones are safe to drop.
      extraTrackingParams: [],
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

    return {
      ok: true,
      url: generic.url.toString(),
      platform: this.platform,
      // Not derivable yet — see the class comment.
      videoId: null,
      requiresResolution: SHORT_LINK_HOSTS.has(generic.url.hostname),
      changed: generic.changed,
    };
  }
}
