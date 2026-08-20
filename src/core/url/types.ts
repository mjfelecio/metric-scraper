import { type Platform } from '../models/platform.js';

export type UrlNormalizationErrorCode = 'invalid_url' | 'unsupported_platform';

export interface UrlNormalizationSuccess {
  ok: true;
  /** Canonical form used for requests, de-duplication and the output row. */
  url: string;
  platform: Platform;
  /**
   * Platform-native id, when it can be derived from the URL alone.
   *
   * TikTok canonical video/photo URLs expose this id directly. Platforms or URL forms
   * whose native id cannot be verified keep it `null`.
   */
  videoId: string | null;
  /**
   * True when the URL is a short/redirect form that needs a network round trip
   * before a canonical URL is known.
   */
  requiresResolution: boolean;
  /** True when normalization changed the string the user supplied. */
  changed: boolean;
}

export interface UrlNormalizationFailure {
  ok: false;
  code: UrlNormalizationErrorCode;
  message: string;
}

export type UrlNormalizationResult = UrlNormalizationSuccess | UrlNormalizationFailure;

/**
 * Per-platform URL canonicalization.
 *
 * Implementations are expected to grow as the acquisition mechanism for each
 * platform is investigated (short-link resolution, id extraction, which query
 * parameters are load-bearing). The interface is what the rest of the system
 * depends on, so those changes stay local.
 */
export interface UrlNormalizer {
  readonly platform: Platform;
  /** Whether this normalizer owns the given parsed URL, by hostname. */
  matches(url: URL): boolean;
  /** Canonicalize a raw user-supplied string. */
  normalize(raw: string): UrlNormalizationResult;
}
