import { describe, expect, it } from 'vitest';

import { isAbortLikeError, ScrapeError } from '../../src/core/models/errors.js';

describe('isAbortLikeError', () => {
  it('recognises both names an AbortSignal reports a timeout under', () => {
    expect(isAbortLikeError(new DOMException('aborted due to timeout', 'TimeoutError'))).toBe(true);
    expect(isAbortLikeError(new DOMException('aborted', 'AbortError'))).toBe(true);
  });

  it('does not claim ordinary errors', () => {
    expect(isAbortLikeError(new Error('boom'))).toBe(false);
    expect(isAbortLikeError('TimeoutError')).toBe(false);
    expect(isAbortLikeError(null)).toBe(false);
  });
});

describe('ScrapeError.from', () => {
  it('classifies an AbortSignal.timeout() rejection as a retryable timeout', () => {
    // AbortSignal.timeout() rejects with TimeoutError, not AbortError. Treating
    // only the latter as a timeout left every attempt-timeout raised outside the
    // transport — the egress rate limiter's queue, in particular — classified
    // `unknown`, which is non-retryable: the job died terminally on attempt 1
    // and was reported as an unclassified failure.
    const error = ScrapeError.from(
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    );

    expect(error.code).toBe('timeout');
    expect(error.retryable).toBe(true);
  });

  it('classifies an AbortController abort as a timeout too', () => {
    const error = ScrapeError.from(new DOMException('The operation was aborted', 'AbortError'));
    expect(error.code).toBe('timeout');
  });

  it('leaves genuinely unclassified errors as unknown', () => {
    const error = ScrapeError.from(new Error('something else entirely'));
    expect(error.code).toBe('unknown');
    expect(error.retryable).toBe(false);
  });

  it('passes a ScrapeError through by identity', () => {
    const original = new ScrapeError({ code: 'throttled', message: 'queue too deep' });
    expect(ScrapeError.from(original)).toBe(original);
  });
});

describe('throttled', () => {
  it('is retryable and reported as a plain error, not as upstream rate limiting', () => {
    const error = new ScrapeError({ code: 'throttled', message: 'queue too deep' });

    expect(error.retryable).toBe(true);
    // NOT `rate_limited`: that status means the platform pushed back, and it is
    // what marks a proxy blocked. Our own ceiling must not bench a healthy proxy.
    expect(error.status).toBe('error');
  });
});
