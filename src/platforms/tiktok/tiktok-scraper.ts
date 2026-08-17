import { type Platform } from '../../core/models/platform.js';
import { scrapeFailure, type ScrapeResult } from '../../core/models/scrape-result.js';
import { type ScrapeContext } from '../../core/scraper/scrape-context.js';
import { type Scraper } from '../../core/scraper/scraper.js';

/**
 * TikTok acquisition — NOT IMPLEMENTED.
 *
 * This is the seam the real implementation drops into. Everything around it is
 * finished: the runner will schedule this, retry it, lease it a proxy and a
 * session, time it, and turn whatever it returns into a JSONL row.
 *
 * It deliberately does not attempt a request. How TikTok exposes public
 * engagement metrics — whether an HTML document carries them, what an
 * unauthenticated request actually returns, what triggers a challenge — has
 * not been investigated, and shipping a plausible-looking request that quietly
 * returns nothing would be worse than an explicit failure.
 *
 * When implementing:
 *
 * 1. Use `context.http` for every request. Never construct a client here — that
 *    is what keeps this class testable with canned responses.
 * 2. Pass `context.proxy?.target` as `proxy` and `context.session?.session.cookie`
 *    as `cookie` on each request.
 * 3. Honour `context.signal` so run cancellation and timeouts work.
 * 4. Return `scrapeSuccess({...})` with whatever metrics were found and `null`
 *    for anything the platform does not expose — do not substitute zeros.
 * 5. Map observed conditions onto statuses: deleted → `not_found`, non-public →
 *    `private`, throttled → `rate_limited`, everything else → `error`.
 * 6. Extend `TikTokUrlNormalizer` at the same time, so `video_id` stops being null.
 */
export class TikTokScraper implements Scraper {
  readonly platform: Platform = 'tiktok';

  scrape(url: string, context: ScrapeContext): Promise<ScrapeResult> {
    context.logger.debug({ url, attempt: context.attempt }, 'tiktok scraper is a placeholder');

    return Promise.resolve(
      scrapeFailure('error', {
        code: 'not_implemented',
        message:
          'TikTok acquisition is not implemented yet; see src/platforms/tiktok/tiktok-scraper.ts',
        // Not retryable: retrying an unimplemented scraper only burns budget
        // and would inflate the retry statistics.
        retryable: false,
      }),
    );
  }
}
