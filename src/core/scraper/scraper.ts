import { type Platform } from '../models/platform.js';
import { type ScrapeResult } from '../models/scrape-result.js';

import { type ScrapeContext } from './scrape-context.js';

/**
 * The one contract every platform implements.
 *
 * `scrape` describes a SINGLE attempt. Retries, backoff, timing, proxy and
 * session leasing, output and metrics all live outside — which is why the
 * orchestration layer never needs to know a platform's details.
 *
 * Implementations should prefer returning a `ScrapeFailure` over throwing;
 * anything thrown is normalised into one by the runner, but returning is
 * explicit about the status the failure maps to.
 */
export interface Scraper {
  readonly platform: Platform;
  scrape(url: string, context: ScrapeContext): Promise<ScrapeResult>;
}

export interface ScraperRegistry {
  get(platform: Platform): Scraper | undefined;
  readonly platforms: readonly Platform[];
}

export function createScraperRegistry(scrapers: readonly Scraper[]): ScraperRegistry {
  const byPlatform = new Map<Platform, Scraper>();
  for (const scraper of scrapers) {
    byPlatform.set(scraper.platform, scraper);
  }
  return {
    get: (platform) => byPlatform.get(platform),
    platforms: [...byPlatform.keys()],
  };
}
