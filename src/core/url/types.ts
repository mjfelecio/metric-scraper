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
   * Currently always `null`: the URL→id mapping for both platforms has not been
   * verified yet, and guessing it would put fabricated ids in the dataset.
   * See `docs` notes in each platform normalizer.
   */
  videoId: string | null;
  /**
   * True when the URL is a short/redirect form that needs a network round trip
   * before a canonical URL is known. Resolution is not implemented yet.
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
