import { type ScrapeErrorInfo } from './errors.js';
import { type ScrapedVideoData } from './snapshot.js';
import { type FailureStatus } from './status.js';

/**
 * What a platform implementation returns for a single attempt.
 *
 * Deliberately narrower than `MetricSnapshot`: a scraper reports what it found
 * (or why it could not), and the runner turns that into a row. This keeps
 * timing, retry accounting and the output contract out of platform code.
 */
export type ScrapeResult = ScrapeSuccess | ScrapeFailure;

export interface ScrapeSuccess {
  outcome: 'ok';
  data: ScrapedVideoData;
}

export interface ScrapeFailure {
  outcome: 'failure';
  status: FailureStatus;
  error: ScrapeErrorInfo;
  /** Anything that was still recoverable, e.g. an id parsed from the URL. */
  partial?: Partial<ScrapedVideoData> | undefined;
}

export function scrapeSuccess(data: ScrapedVideoData): ScrapeSuccess {
  return { outcome: 'ok', data };
}

export function scrapeFailure(
  status: FailureStatus,
  error: ScrapeErrorInfo,
  partial?: Partial<ScrapedVideoData>,
): ScrapeFailure {
  return { outcome: 'failure', status, error, partial };
}

export function isScrapeSuccess(result: ScrapeResult): result is ScrapeSuccess {
  return result.outcome === 'ok';
}
