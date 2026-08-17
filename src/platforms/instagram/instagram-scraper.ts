import { type Platform } from '../../core/models/platform.js';
import { scrapeFailure, type ScrapeResult } from '../../core/models/scrape-result.js';
import { type ScrapeContext } from '../../core/scraper/scrape-context.js';
import { type Scraper } from '../../core/scraper/scraper.js';

/**
 * Instagram acquisition — NOT IMPLEMENTED.
 *
 * Same contract and same seam as {@link ../tiktok/tiktok-scraper.js}. No
 * request is attempted: how Instagram exposes public engagement metrics for
 * Reels and video posts, and what an unauthenticated request returns, has not
 * been investigated.
 *
 * Two things worth settling during that investigation, because they change the
 * shape of the output rather than just the implementation:
 *
 * - which of `views` / `shares` / `saves` are publicly exposed at all (any that
 *   are not must stay `null`, never 0)
 * - whether a logged-in session is required, which is what decides if
 *   `SessionPool` gets real entries or stays empty
 *
 * See the TikTok placeholder for the step-by-step implementation notes; they
 * apply here unchanged.
 */
export class InstagramScraper implements Scraper {
  readonly platform: Platform = 'instagram';

  scrape(url: string, context: ScrapeContext): Promise<ScrapeResult> {
    context.logger.debug({ url, attempt: context.attempt }, 'instagram scraper is a placeholder');

    return Promise.resolve(
      scrapeFailure('error', {
        code: 'not_implemented',
        message:
          'Instagram acquisition is not implemented yet; see src/platforms/instagram/instagram-scraper.ts',
        retryable: false,
      }),
    );
  }
}
