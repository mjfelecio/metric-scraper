import { describe, expect, it, vi } from 'vitest';

import { HttpError } from '../../src/core/scraper/http-port.js';
import { FetchHttpClient } from '../../src/infrastructure/http/fetch-http-client.js';

/** Builds the shape `fetch failed` errors have: a generic TypeError wrapping the real cause. */
function fetchFailed(cause: Error): TypeError {
  return new TypeError('fetch failed', { cause });
}

function coded(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function client(fetchImpl: typeof fetch): FetchHttpClient {
  return new FetchHttpClient({ defaultTimeoutMs: 5_000, fetchImpl });
}

async function requestError(fetchImpl: typeof fetch): Promise<HttpError> {
  const c = client(fetchImpl);
  try {
    await c.request({ url: 'https://example.com/video/1' });
    throw new Error('expected request() to reject');
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return error;
  }
}

describe('FetchHttpClient error cause preservation', () => {
  it('preserves ECONNREFUSED as the causeCode and names it in the message', async () => {
    const error = await requestError(() =>
      Promise.reject(fetchFailed(coded('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:9'))),
    );

    expect(error.code).toBe('network_error');
    expect(error.causeCode).toBe('ECONNREFUSED');
    expect(error.message).toContain('ECONNREFUSED');
    expect(error.message).not.toBe('request to https://example.com/video/1 failed: fetch failed');
  });

  it('preserves ECONNRESET', async () => {
    const error = await requestError(() =>
      Promise.reject(fetchFailed(coded('ECONNRESET', 'socket hang up'))),
    );

    expect(error.code).toBe('network_error');
    expect(error.causeCode).toBe('ECONNRESET');
    expect(error.message).toContain('ECONNRESET');
  });

  it('preserves ENOTFOUND (DNS failure)', async () => {
    const error = await requestError(() =>
      Promise.reject(fetchFailed(coded('ENOTFOUND', 'getaddrinfo ENOTFOUND dead-host.invalid'))),
    );

    expect(error.code).toBe('network_error');
    expect(error.causeCode).toBe('ENOTFOUND');
    expect(error.message).toContain('ENOTFOUND');
  });

  it('classifies a connect timeout as `timeout`, not `network_error`', async () => {
    const error = await requestError(() =>
      Promise.reject(
        fetchFailed(
          coded(
            'UND_ERR_CONNECT_TIMEOUT',
            'Connect Timeout Error (attempted address: 198.51.100.7:8080, timeout: 10000ms)',
          ),
        ),
      ),
    );

    expect(error.code).toBe('timeout');
    expect(error.causeCode).toBe('UND_ERR_CONNECT_TIMEOUT');
    expect(error.message).toContain('UND_ERR_CONNECT_TIMEOUT');
  });

  it('classifies a bare ETIMEDOUT the same way as a connect timeout', async () => {
    const error = await requestError(() =>
      Promise.reject(fetchFailed(coded('ETIMEDOUT', 'connect ETIMEDOUT 198.51.100.7:8080'))),
    );

    expect(error.code).toBe('timeout');
    expect(error.causeCode).toBe('ETIMEDOUT');
  });

  it('walks past an intermediate uncoded wrapper to a deeper coded cause', async () => {
    const deep = coded('ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.1:3128');
    const middle = new Error('wrapped', { cause: deep });
    const error = await requestError(() => Promise.reject(fetchFailed(middle)));

    expect(error.causeCode).toBe('ECONNREFUSED');
  });

  it('falls back to the original message when nothing in the chain is coded', async () => {
    const error = await requestError(() =>
      Promise.reject(fetchFailed(new Error('some uncoded transport failure'))),
    );

    expect(error.code).toBe('network_error');
    expect(error.causeCode).toBeUndefined();
    expect(error.message).toContain('some uncoded transport failure');
  });

  it('handles a bare error with no cause at all', async () => {
    const error = await requestError(() => Promise.reject(new Error('totally generic')));

    expect(error.code).toBe('network_error');
    expect(error.causeCode).toBeUndefined();
    expect(error.message).toContain('totally generic');
  });

  it('redacts credential-shaped substrings in the terminal message, defense in depth', async () => {
    const error = await requestError(() =>
      Promise.reject(
        fetchFailed(
          coded('ECONNREFUSED', 'connect ECONNREFUSED via http://user:secret@proxy.example:8080'),
        ),
      ),
    );

    expect(error.message).not.toContain('secret');
    expect(error.message).toContain('***');
  });

  it('never lets ScrapeErrorInfo.toInfo() drop the causeCode', async () => {
    const error = await requestError(() =>
      Promise.reject(fetchFailed(coded('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:9'))),
    );

    expect(error.toInfo()).toMatchObject({
      code: 'network_error',
      causeCode: 'ECONNREFUSED',
      retryable: true,
    });
  });

  it('leaves the request-level abort/timeout path unaffected', async () => {
    const abortError = new DOMException('The operation was aborted', 'TimeoutError');
    const error = await requestError(() => Promise.reject(abortError));

    expect(error.code).toBe('timeout');
    expect(error.causeCode).toBeUndefined();
  });

  it('passes an already-built HttpError through unchanged', async () => {
    const original = new HttpError({ code: 'config_error', message: 'boom' });
    const c = client(() => Promise.reject(original));

    await expect(c.request({ url: 'https://example.com' })).rejects.toBe(original);
  });
});

describe('FetchHttpClient — successful requests are unaffected', () => {
  it('still returns a normal response when fetch succeeds', async () => {
    const c = client(
      vi.fn().mockResolvedValue(
        new Response('body', {
          status: 200,
          statusText: 'OK',
        }),
      ),
    );

    const response = await c.request({ url: 'https://example.com/ok' });
    expect(response.status).toBe(200);
    expect(response.body).toBe('body');
  });
});
