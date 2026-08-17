import { ScrapeError } from '../models/errors.js';
import { type ScrapeResult } from '../models/scrape-result.js';
import { isPermanentStatus } from '../models/status.js';

export interface RetryPolicyOptions {
  /** Total attempts including the first. `1` disables retrying. */
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  /** Multiplier applied per attempt. `2` = 250ms, 500ms, 1000ms, … */
  backoffFactor: number;
  /**
   * Full jitter (`delay * random()`), which is what keeps a large batch from
   * re-firing in lockstep after a rate limit.
   */
  jitter: boolean;
}

export const DEFAULT_RETRY_OPTIONS: RetryPolicyOptions = {
  maxAttempts: 3,
  initialDelayMs: 250,
  maxDelayMs: 10_000,
  backoffFactor: 2,
  jitter: true,
};

/**
 * Decides whether to try again and how long to wait first.
 *
 * Permanent outcomes (`not_found`, `private`) are never retried: the answer
 * will not change, and retrying them would burn proxy budget and skew the
 * retry statistics that the run summary reports.
 */
export class RetryPolicy {
  readonly options: RetryPolicyOptions;
  private readonly random: () => number;

  constructor(options: Partial<RetryPolicyOptions> = {}, random: () => number = Math.random) {
    const merged = { ...DEFAULT_RETRY_OPTIONS, ...options };
    if (merged.maxAttempts < 1) {
      throw new RangeError('maxAttempts must be >= 1');
    }
    if (merged.backoffFactor < 1) {
      throw new RangeError('backoffFactor must be >= 1');
    }
    if (merged.initialDelayMs < 0 || merged.maxDelayMs < 0) {
      throw new RangeError('retry delays must be >= 0');
    }
    this.options = merged;
    this.random = random;
  }

  /** Whether a further attempt is allowed after `attempt` (1-based) failed. */
  hasAttemptsLeft(attempt: number): boolean {
    return attempt < this.options.maxAttempts;
  }

  /** Backoff before attempt `attempt + 1`, in milliseconds. */
  delayFor(attempt: number): number {
    const exponent = Math.max(0, attempt - 1);
    const raw = this.options.initialDelayMs * Math.pow(this.options.backoffFactor, exponent);
    const capped = Math.min(raw, this.options.maxDelayMs);
    const delay = this.options.jitter ? capped * this.random() : capped;
    return Math.round(delay);
  }

  /** Whether an arbitrary thrown value is worth retrying. */
  isRetryableError(error: unknown): boolean {
    return ScrapeError.from(error).retryable;
  }

  /** Whether a returned failure result is worth retrying. */
  isRetryableResult(result: ScrapeResult): boolean {
    if (result.outcome === 'ok') return false;
    if (isPermanentStatus(result.status)) return false;
    return result.error.retryable;
  }
}
