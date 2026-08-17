import { type Platform } from '../models/platform.js';

import { normalizeUrlGeneric } from './generic.js';
import { type UrlNormalizationResult, type UrlNormalizer } from './types.js';

/**
 * Routes a raw URL to the normalizer that owns its host.
 *
 * The registry is constructed with its normalizers rather than importing them,
 * so `core` never depends on `platforms`.
 */
export class UrlNormalizerRegistry {
  private readonly normalizers: readonly UrlNormalizer[];

  constructor(normalizers: readonly UrlNormalizer[]) {
    this.normalizers = normalizers;
  }

  get platforms(): Platform[] {
    return this.normalizers.map((normalizer) => normalizer.platform);
  }

  /** Identify the owning platform without canonicalizing. */
  detect(raw: string): Platform | null {
    const generic = normalizeUrlGeneric(raw);
    if (!generic.ok) return null;
    return this.normalizers.find((n) => n.matches(generic.url))?.platform ?? null;
  }

  normalize(raw: string): UrlNormalizationResult {
    const generic = normalizeUrlGeneric(raw);
    if (!generic.ok) {
      return { ok: false, code: 'invalid_url', message: generic.message };
    }

    const normalizer = this.normalizers.find((candidate) => candidate.matches(generic.url));
    if (normalizer === undefined) {
      return {
        ok: false,
        code: 'unsupported_platform',
        message: `no scraper handles host "${generic.url.hostname}"`,
      };
    }

    return normalizer.normalize(raw);
  }
}
