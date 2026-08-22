import { warning, type CapacityFinding } from './findings.js';
import { type ReliabilityInputs } from './inputs.js';

/**
 * How many attempts a scrape job really costs.
 *
 * The brief asks for five reliability knobs, but at most three of them are
 * independent, and two ways of choosing three give wrong answers. What makes
 * the difference is that failures come in two populations the retry policy
 * treats completely differently (`src/core/models/errors.ts:88-113`):
 *
 * - **permanent** — `not_found`, `private`, `parse_error`. Never retried.
 * - **retryable** — `timeout`, `network_error`, `throttled`, `proxy_error`, …
 *
 * In the reference run all 81 failures were permanent, so fitting a per-attempt
 * failure rate to the 94.94% *job* success rate as though every failure were
 * retryable predicts a 28.7% retry rate against a measured 0.99%. Separating the
 * two populations reproduces that run to five decimal places instead.
 *
 * Modelling assumption, stated because it matters: attempt outcomes are treated
 * as independent. Real failures cluster — a blocked proxy fails every attempt —
 * so this slightly under-states exhaustion and over-states the value of
 * retrying. A two-state model would be more faithful and would need two more
 * parameters nobody has measured.
 */

export interface ReliabilityModel {
  /** Probability one attempt fails, among retry-eligible jobs. */
  readonly perAttemptFailureRate: number;
  /**
   * Mean attempts per job, over all jobs. **This is the traffic multiplier**:
   * every attempt repeats the job's whole HTTP fan-out.
   */
  readonly attemptAmplification: number;
  readonly jobSuccessRate: number;
  readonly jobErrorRate: number;
  /** Failed permanently on the first attempt — never retried. */
  readonly permanentFailureRate: number;
  /** Retried to the attempt limit and still failed. */
  readonly exhaustedRate: number;
  /** Share of all jobs that make at least one retry. The brief's "retry rate". */
  readonly retryRate: number;
  /** Mean retries among jobs that retried at all. */
  readonly avgRetriesPerRetriedJob: number;
  /** Mean retries among jobs that ended up failing. The brief's other reading. */
  readonly avgRetriesPerFailedJob: number;
  readonly maxRetries: number;
  /**
   * Mean backoff sleep a job incurs.
   *
   * A retry holds its worker slot while it waits, but the runner releases the
   * proxy lease before sleeping. This latency therefore affects worker/job
   * concurrency, not proxy concurrency (`scrape-runner.ts`).
   */
  readonly expectedBackoffMsPerJob: number;
  readonly findings: readonly CapacityFinding[];
}

export function evaluateReliability(input: ReliabilityInputs): ReliabilityModel {
  const attempts = Math.max(1, Math.floor(input.maxAttempts));
  const q = clamp01(input.nonRetryableShare);
  const p = clamp01(1 - clamp01(input.perAttemptSuccessRate));
  const retryable = 1 - q;

  // Geometric series for expected attempts. The p === 1 branch is not an edge
  // case to tolerate but the "nothing ever succeeds" scenario an operator will
  // deliberately try, and (1 - p) would be a division by zero.
  const expectedAttempts = p === 1 ? attempts : (1 - p ** attempts) / (1 - p);

  const exhaustedRate = retryable * p ** attempts;
  const jobSuccessRate = retryable * (1 - p ** attempts);
  const attemptAmplification = q * 1 + retryable * expectedAttempts;
  const retryRate = retryable * p;
  const avgRetriesPerRetriedJob = p === 0 ? 0 : (expectedAttempts - 1) / p;
  const failureRate = q + exhaustedRate;
  const avgRetriesPerFailedJob =
    failureRate === 0 ? 0 : (exhaustedRate * (attempts - 1)) / failureRate;

  const findings: CapacityFinding[] = [];
  if (attemptAmplification > 1.5) {
    findings.push(
      warning(
        'retry_amplification_high',
        `retries multiply outbound HTTP traffic by ${attemptAmplification.toFixed(2)}x`,
      ),
    );
  }

  return {
    perAttemptFailureRate: p,
    attemptAmplification,
    jobSuccessRate,
    jobErrorRate: 1 - jobSuccessRate,
    permanentFailureRate: q,
    exhaustedRate,
    retryRate,
    avgRetriesPerRetriedJob,
    avgRetriesPerFailedJob,
    maxRetries: attempts - 1,
    expectedBackoffMsPerJob: expectedBackoff(input, p, retryable, attempts),
    findings,
  };
}

/**
 * `sum over retry i of P(reaching retry i) x delay(i)`.
 *
 * Mirrors `RetryPolicy.delayFor`: exponential from `initialDelayMs`, capped at
 * `maxDelayMs`. Full jitter multiplies each delay by a uniform `[0, 1)`, whose
 * expectation is a half — so jitter halves the *expected* wait even though it
 * leaves the worst case alone.
 */
function expectedBackoff(
  input: ReliabilityInputs,
  p: number,
  retryable: number,
  attempts: number,
): number {
  const { initialDelayMs, maxDelayMs, backoffFactor, jitter } = input.retryBackoff;
  const jitterFactor = jitter ? 0.5 : 1;
  let total = 0;
  for (let retry = 1; retry < attempts; retry += 1) {
    const delay = Math.min(initialDelayMs * backoffFactor ** (retry - 1), maxDelayMs);
    total += p ** retry * delay * jitterFactor;
  }
  return retryable * total;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
