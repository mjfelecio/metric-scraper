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

export interface AcquisitionMetadata {
  /** Number of platform HTTP calls made during this attempt. */
  httpRequests: number;
  /** Whether operator-supplied authenticated cookies were sent. */
  sessionUsed: boolean;
}

export interface ScrapeSuccess {
  outcome: 'ok';
  data: ScrapedVideoData;
  acquisition?: AcquisitionMetadata | undefined;
}

export interface ScrapeFailure {
  outcome: 'failure';
  status: FailureStatus;
  error: ScrapeErrorInfo;
  /** Anything that was still recoverable, e.g. an id parsed from the URL. */
  partial?: Partial<ScrapedVideoData> | undefined;
  acquisition?: AcquisitionMetadata | undefined;
}

export function scrapeSuccess(
  data: ScrapedVideoData,
  acquisition?: AcquisitionMetadata,
): ScrapeSuccess {
  return acquisition === undefined ? { outcome: 'ok', data } : { outcome: 'ok', data, acquisition };
}

export function scrapeFailure(
  status: FailureStatus,
  error: ScrapeErrorInfo,
  partial?: Partial<ScrapedVideoData>,
  acquisition?: AcquisitionMetadata,
): ScrapeFailure {
  return acquisition === undefined
    ? { outcome: 'failure', status, error, partial }
    : { outcome: 'failure', status, error, partial, acquisition };
}

export function isScrapeSuccess(result: ScrapeResult): result is ScrapeSuccess {
  return result.outcome === 'ok';
}
