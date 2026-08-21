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
    // transport classified `unknown`, which is non-retryable: the job died
    // terminally on attempt 1 and was reported as an unclassified failure.
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
    const original = new ScrapeError({ code: 'parse_error', message: 'unreadable body' });
    expect(ScrapeError.from(original)).toBe(original);
  });
});
