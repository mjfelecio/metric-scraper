import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { BandwidthAggregator } from '../../src/core/metrics/bandwidth.js';
import { createCountingInterceptor } from '../../src/infrastructure/http/counting-dispatcher.js';

/** Minimal stand-in for an undici dispatch handler, methods on the prototype. */
class FakeHandler {
  readonly events: string[] = [];
  readonly chunks: Buffer[] = [];
  readonly errors: unknown[] = [];

  onRequestStart(): void {
    this.events.push('requestStart');
  }
  onResponseStart(): void {
    this.events.push('responseStart');
  }
  onResponseData(_controller: unknown, chunk: Buffer): void {
    this.chunks.push(chunk);
  }
  onResponseEnd(): void {
    this.events.push('responseEnd');
  }
  onResponseError(_controller: unknown, error: unknown): void {
    this.events.push('responseError');
    this.errors.push(error);
  }
}

/** Drives a wrapped handler through one full response lifecycle. */
function dispatchWith(
  chunks: readonly Buffer[],
  responseHeaders: Record<string, string>,
): (opts: unknown, handler: Record<string, (...args: never[]) => unknown>) => boolean {
  return (_opts, handler) => {
    const controller = {};
    handler.onRequestStart?.(controller as never, {} as never);
    handler.onResponseStart?.(
      controller as never,
      200 as never,
      responseHeaders as never,
      'OK' as never,
    );
    for (const chunk of chunks) handler.onResponseData?.(controller as never, chunk as never);
    handler.onResponseEnd?.(controller as never, {} as never);
    return true;
  };
}

/**
 * Drives a wrapped handler through a transfer that fails mid-flight: some
 * response data arrives, then the transfer errors instead of ending normally.
 * `onResponseEnd` is never called.
 */
function dispatchWithMidflightError(
  chunks: readonly Buffer[],
  responseHeaders: Record<string, string>,
  error: unknown,
): (opts: unknown, handler: Record<string, (...args: never[]) => unknown>) => boolean {
  return (_opts, handler) => {
    const controller = {};
    handler.onRequestStart?.(controller as never, {} as never);
    handler.onResponseStart?.(
      controller as never,
      200 as never,
      responseHeaders as never,
      'OK' as never,
    );
    for (const chunk of chunks) handler.onResponseData?.(controller as never, chunk as never);
    handler.onResponseError?.(controller as never, error as never);
    return true;
  };
}

describe('createCountingInterceptor', () => {
  const opts = {
    method: 'GET',
    path: '/embed/v2/123',
    headers: { host: 'www.tiktok.com', 'accept-encoding': 'gzip' },
  };

  it('counts response body bytes as the sum of wire chunks', () => {
    const sink = new BandwidthAggregator();
    const interceptor = createCountingInterceptor({ sink, proxyId: 'p1' });
    const chunks = [Buffer.alloc(1000), Buffer.alloc(2400)];

    interceptor(dispatchWith(chunks, {}) as never)(opts, new FakeHandler());

    expect(sink.view().responseBytes).toBe(3400);
  });

  it('counts request line and headers as request bytes', () => {
    const sink = new BandwidthAggregator();
    const interceptor = createCountingInterceptor({ sink, proxyId: 'p1' });

    interceptor(dispatchWith([], {}) as never)(opts, new FakeHandler());

    // "GET /embed/v2/123 HTTP/1.1\r\n" + both headers + the blank line.
    expect(sink.view().requestBytes).toBeGreaterThan(50);
  });

  it('includes response header bytes in the response total', () => {
    const sink = new BandwidthAggregator();
    const interceptor = createCountingInterceptor({ sink, proxyId: 'p1' });

    interceptor(dispatchWith([Buffer.alloc(100)], { 'content-type': 'text/html' }) as never)(
      opts,
      new FakeHandler(),
    );

    expect(sink.view().responseBytes).toBeGreaterThan(100);
  });

  /**
   * The regression that matters: undici v7 keeps handler methods on the
   * prototype, so a naive spread drops them and the request hangs forever.
   */
  it('passes the whole lifecycle through to the wrapped handler', () => {
    const sink = new BandwidthAggregator();
    const handler = new FakeHandler();
    const interceptor = createCountingInterceptor({ sink, proxyId: 'p1' });

    interceptor(dispatchWith([Buffer.alloc(8)], {}) as never)(opts, handler);

    expect(handler.events).toEqual(['requestStart', 'responseStart', 'responseEnd']);
    expect(handler.chunks).toHaveLength(1);
    expect(handler.chunks[0]?.length).toBe(8);
  });

  it('attributes the sample to its proxy id', () => {
    const sink = new BandwidthAggregator();
    createCountingInterceptor({ sink, proxyId: 'proxy-7' })(dispatchWith([], {}) as never)(
      opts,
      new FakeHandler(),
    );

    expect(sink.view().perProxy[0]?.proxyId).toBe('proxy-7');
  });

  it('records a null proxy id for direct traffic', () => {
    const sink = new BandwidthAggregator();
    createCountingInterceptor({ sink, proxyId: null })(dispatchWith([], {}) as never)(
      opts,
      new FakeHandler(),
    );

    expect(sink.view().perProxy[0]?.proxyId).toBeNull();
  });

  it('still records when the response carries no body', () => {
    const sink = new BandwidthAggregator();
    createCountingInterceptor({ sink, proxyId: null })(dispatchWith([], {}) as never)(
      opts,
      new FakeHandler(),
    );

    expect(sink.view().requests).toBe(1);
  });

  /**
   * The reason this whole component exists. Counting at the HttpClient port
   * would see the decompressed body; the dispatcher sees the wire. Measured
   * 5.08:1 live on a gzipped page, so the gap is not academic.
   */
  it('counts the compressed size, not the decompressed one', () => {
    const original = Buffer.from('<html>' + 'a'.repeat(50_000) + '</html>');
    const compressed = gzipSync(original);
    expect(compressed.byteLength).toBeLessThan(original.byteLength / 2);

    const sink = new BandwidthAggregator();
    createCountingInterceptor({ sink, proxyId: null })(
      dispatchWith([compressed], { 'content-encoding': 'gzip' }) as never,
    )(opts, new FakeHandler());

    const responseBytes = sink.view().responseBytes;
    expect(responseBytes).toBeGreaterThanOrEqual(compressed.byteLength);
    expect(responseBytes).toBeLessThan(original.byteLength);
  });

  /**
   * A transfer that fails mid-flight — routine with proxies — still consumed
   * bandwidth up to the point of failure, so `onResponseError` must record it
   * exactly once instead of silently dropping it.
   */
  it('records bytes consumed before a mid-flight response error, exactly once', () => {
    const sink = new BandwidthAggregator();
    const handler = new FakeHandler();
    const interceptor = createCountingInterceptor({ sink, proxyId: 'p1' });
    const chunks = [Buffer.alloc(500), Buffer.alloc(300)];
    const transferError = new Error('socket hang up');

    interceptor(dispatchWithMidflightError(chunks, {}, transferError) as never)(opts, handler);

    // The failure path was actually driven, not the happy path.
    expect(handler.events).toEqual(['requestStart', 'responseStart', 'responseError']);
    expect(handler.errors).toEqual([transferError]);

    const view = sink.view();
    expect(view.requests).toBe(1);
    expect(view.responseBytes).toBe(800);
    expect(view.requestBytes).toBeGreaterThan(0);

    // Recorded exactly once: a single sample in the aggregator's per-proxy view.
    expect(view.perProxy).toHaveLength(1);
    expect(view.perProxy[0]?.requests).toBe(1);
  });
});
