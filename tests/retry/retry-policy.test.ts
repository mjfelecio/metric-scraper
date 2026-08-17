import { describe, expect, it } from 'vitest';

import { ScrapeError } from '../../src/core/models/errors.js';
import { scrapeFailure, scrapeSuccess } from '../../src/core/models/scrape-result.js';
import { EMPTY_VIDEO_DATA } from '../../src/core/models/snapshot.js';
import { RetryPolicy } from '../../src/core/retry/retry-policy.js';

const noJitter = { jitter: false } as const;

describe('RetryPolicy backoff', () => {
  it('grows exponentially from the initial delay', () => {
    const policy = new RetryPolicy({
      ...noJitter,
      initialDelayMs: 100,
      backoffFactor: 2,
      maxDelayMs: 10_000,
      maxAttempts: 6,
    });

    expect(policy.delayFor(1)).toBe(100);
    expect(policy.delayFor(2)).toBe(200);
    expect(policy.delayFor(3)).toBe(400);
    expect(policy.delayFor(4)).toBe(800);
  });

  it('caps at the maximum delay', () => {
    const policy = new RetryPolicy({
      ...noJitter,
      initialDelayMs: 1_000,
      backoffFactor: 10,
      maxDelayMs: 5_000,
      maxAttempts: 10,
    });

    expect(policy.delayFor(1)).toBe(1_000);
    expect(policy.delayFor(2)).toBe(5_000);
    expect(policy.delayFor(9)).toBe(5_000);
  });

  it('applies full jitter within [0, capped delay]', () => {
    const policy = new RetryPolicy(
      { jitter: true, initialDelayMs: 1_000, backoffFactor: 2, maxDelayMs: 10_000 },
      () => 0.5,
    );
    expect(policy.delayFor(1)).toBe(500);
    expect(policy.delayFor(2)).toBe(1_000);
  });

  it('supports a backoff factor of 1 (constant delay)', () => {
    const policy = new RetryPolicy({ ...noJitter, initialDelayMs: 250, backoffFactor: 1 });
    expect(policy.delayFor(1)).toBe(250);
    expect(policy.delayFor(5)).toBe(250);
  });

  it('rejects nonsensical configuration', () => {
    expect(() => new RetryPolicy({ maxAttempts: 0 })).toThrow(RangeError);
    expect(() => new RetryPolicy({ backoffFactor: 0.5 })).toThrow(RangeError);
    expect(() => new RetryPolicy({ initialDelayMs: -1 })).toThrow(RangeError);
  });
});

describe('RetryPolicy attempt budget', () => {
  it('allows exactly maxAttempts attempts', () => {
    const policy = new RetryPolicy({ maxAttempts: 3 });
    expect(policy.hasAttemptsLeft(1)).toBe(true);
    expect(policy.hasAttemptsLeft(2)).toBe(true);
    expect(policy.hasAttemptsLeft(3)).toBe(false);
  });

  it('disables retrying when maxAttempts is 1', () => {
    expect(new RetryPolicy({ maxAttempts: 1 }).hasAttemptsLeft(1)).toBe(false);
  });
});

describe('RetryPolicy retryability', () => {
  const policy = new RetryPolicy();

  it('never retries a success', () => {
    expect(policy.isRetryableResult(scrapeSuccess(EMPTY_VIDEO_DATA))).toBe(false);
  });

  it('never retries permanent outcomes', () => {
    const notFound = scrapeFailure('not_found', {
      code: 'not_found',
      message: 'gone',
      retryable: false,
    });
    const isPrivate = scrapeFailure('private', {
      code: 'private',
      message: 'private account',
      retryable: false,
    });

    expect(policy.isRetryableResult(notFound)).toBe(false);
    expect(policy.isRetryableResult(isPrivate)).toBe(false);
  });

  it('does not retry a permanent status even if the error claims to be retryable', () => {
    const contradictory = scrapeFailure('not_found', {
      code: 'network_error',
      message: 'mislabelled',
      retryable: true,
    });
    expect(policy.isRetryableResult(contradictory)).toBe(false);
  });

  it('retries throttling and transport failures', () => {
    const throttled = scrapeFailure('rate_limited', {
      code: 'rate_limited',
      message: 'slow down',
      retryable: true,
    });
    const network = scrapeFailure('error', {
      code: 'network_error',
      message: 'connection reset',
      retryable: true,
    });

    expect(policy.isRetryableResult(throttled)).toBe(true);
    expect(policy.isRetryableResult(network)).toBe(true);
  });

  it('does not retry an unimplemented platform', () => {
    const notImplemented = scrapeFailure('error', {
      code: 'not_implemented',
      message: 'placeholder',
      retryable: false,
    });
    expect(policy.isRetryableResult(notImplemented)).toBe(false);
  });

  it('classifies thrown errors by their code', () => {
    expect(policy.isRetryableError(new ScrapeError({ code: 'timeout', message: 'slow' }))).toBe(
      true,
    );
    expect(policy.isRetryableError(new ScrapeError({ code: 'parse_error', message: 'bad' }))).toBe(
      false,
    );
    expect(policy.isRetryableError(new Error('anything else'))).toBe(false);
  });
});
