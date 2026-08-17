import { z } from 'zod';

/**
 * Terminal outcome of a single scrape attempt chain (i.e. after retries).
 *
 * - `ok`           metrics were acquired
 * - `not_found`    the target does not exist / was deleted — permanent
 * - `private`      the target exists but is not publicly readable — permanent
 * - `rate_limited` the platform throttled us — transient
 * - `error`        anything else (network, parse, timeout, not implemented)
 */
export const SCRAPE_STATUSES = ['ok', 'not_found', 'private', 'rate_limited', 'error'] as const;

export const ScrapeStatusSchema = z.enum(SCRAPE_STATUSES);

export type ScrapeStatus = z.infer<typeof ScrapeStatusSchema>;

/** Statuses that represent a failed acquisition. Failures are still written out as rows. */
export type FailureStatus = Exclude<ScrapeStatus, 'ok'>;

/**
 * Statuses that are pointless to retry: the answer will not change by asking again.
 * Kept next to the status definition so retry behaviour stays obvious.
 */
const PERMANENT_STATUSES: ReadonlySet<ScrapeStatus> = new Set<ScrapeStatus>([
  'not_found',
  'private',
]);

export function isPermanentStatus(status: ScrapeStatus): boolean {
  return PERMANENT_STATUSES.has(status);
}

export function isSuccessStatus(status: ScrapeStatus): status is 'ok' {
  return status === 'ok';
}
