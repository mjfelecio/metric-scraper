import {
  createScraperRegistry,
  type Scraper,
  type ScraperRegistry,
} from '../core/scraper/scraper.js';
import { UrlNormalizerRegistry } from '../core/url/normalizer-registry.js';
import { type UrlNormalizer } from '../core/url/types.js';

import { InstagramScraper, type InstagramScraperOptions } from './instagram/instagram-scraper.js';
import { InstagramUrlNormalizer } from './instagram/instagram-url-normalizer.js';
import { TikTokScraper } from './tiktok/tiktok-scraper.js';
import { TikTokUrlNormalizer } from './tiktok/tiktok-url-normalizer.js';

/**
 * The only place that knows which platforms exist.
 *
 * `core` never imports from `platforms`; composition happens here and in
 * `src/app/composition.ts`, so adding a platform is a local change.
 */
export function createDefaultNormalizers(): UrlNormalizer[] {
  return [new TikTokUrlNormalizer(), new InstagramUrlNormalizer()];
}

export function createDefaultUrlNormalizerRegistry(): UrlNormalizerRegistry {
  return new UrlNormalizerRegistry(createDefaultNormalizers());
}

export function createDefaultScrapers(
  options: { instagram?: InstagramScraperOptions } = {},
): Scraper[] {
  return [new TikTokScraper(), new InstagramScraper(options.instagram)];
}

export function createDefaultScraperRegistry(
  options: { instagram?: InstagramScraperOptions } = {},
): ScraperRegistry {
  return createScraperRegistry(createDefaultScrapers(options));
}

export { InstagramScraper, InstagramUrlNormalizer, TikTokScraper, TikTokUrlNormalizer };
