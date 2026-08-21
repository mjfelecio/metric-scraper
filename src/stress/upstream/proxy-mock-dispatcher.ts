import { MockAgent, type Dispatcher } from 'undici';

import { type BandwidthSink } from '../../core/metrics/bandwidth.js';
import { type ProxyTarget } from '../../core/scraper/lease-ports.js';
import { createCountingInterceptor } from '../../infrastructure/http/counting-dispatcher.js';
import { proxyId } from '../../infrastructure/proxy/proxy-config.js';

/**
 * Mock analog of `composition.ts`'s `createProxyAgentFactory`.
 *
 * Production builds one real `ProxyAgent` per distinct proxy URL because
 * different proxies really do need distinct transports. A mock has no such
 * requirement -- there is one shared `MockAgent` with scenario interceptors
 * registered once -- but per-proxy dispatcher *objects* still matter here for
 * one reason: `createCountingInterceptor` tags every recorded byte sample
 * with the `proxyId` closed over at compose time, which is what lets the
 * stress report attribute bandwidth per proxy the same way a real run does.
 * So this still caches one composed dispatcher per proxy target, exactly
 * like production, wrapping the same shared `MockAgent` instead of a new
 * `ProxyAgent` each time.
 */
export function createMockDispatcherFactory(
  mockAgent: MockAgent,
  bandwidthSink: BandwidthSink,
  latencyMs: (opts: RequestTimingLookupInput) => number,
): (target: ProxyTarget) => unknown {
  const dispatchers = new Map<string, unknown>();
  return (target) => {
    let dispatcher = dispatchers.get(target.url);
    if (dispatcher === undefined) {
      dispatcher = mockAgent.compose(
        createLatencyInterceptor(latencyMs),
        createCountingInterceptor({ sink: bandwidthSink, proxyId: proxyId(target) }),
      );
      dispatchers.set(target.url, dispatcher);
    }
    return dispatcher;
  };
}

/** Default (no-proxy/direct) dispatcher, mirroring `composition.ts`'s `defaultDispatcher`. */
export function createMockDefaultDispatcher(
  mockAgent: MockAgent,
  bandwidthSink: BandwidthSink,
  latencyMs: (opts: RequestTimingLookupInput) => number,
): unknown {
  return mockAgent.compose(
    createLatencyInterceptor(latencyMs),
    createCountingInterceptor({ sink: bandwidthSink, proxyId: null }),
  );
}

export interface RequestTimingLookupInput {
  path: string;
  method: string | undefined;
  body: unknown;
}

/**
 * Given `err.code = 'UND_ERR_CONNECT_TIMEOUT'`, `fetch()` wraps whatever a
 * dispatcher errors with into `TypeError('fetch failed', {cause: err})` --
 * verified directly against the installed undici build -- and
 * `FetchHttpClient`'s `toHttpError` walks `.cause` for a `.code` in
 * `CONNECT_TIMEOUT_CODES`, classifying the result `HttpError({code:
 * 'timeout'})` exactly like a real connect-phase timeout.
 *
 * This has to be thrown through `MockInterceptor.replyWithError()` -- a
 * *registered* interceptor -- rather than injected from a custom compose
 * interceptor sitting in front of `MockAgent`. `MockAgent`'s own dispatch
 * implementation expects the legacy `onConnect`/`onError` handler shape and
 * does its own bridging from whatever new-style handler undici's `fetch()`
 * actually handed it; a custom interceptor that never calls the real
 * `dispatch()` never reaches that bridging and silently hangs (verified: it
 * hangs until the outer request timeout, calling `handler.onError` at that
 * layer is a no-op since the handler there has no such method). Each mock
 * upstream module therefore registers a `.replyWithError(simulatedTimeoutError(...))`
 * interceptor, matched by a predicate that independently recomputes the same
 * scenario pick, ahead of its normal `.reply()` registration.
 */
export function simulatedTimeoutError(message: string): Error {
  return Object.assign(new Error(message), { code: 'UND_ERR_CONNECT_TIMEOUT' });
}

/**
 * Injects artificial latency before the request ever reaches `MockAgent`.
 *
 * Delaying the call to the inner `dispatch` (rather than inside a
 * `MockInterceptor.reply()` callback, which must return synchronously) is
 * what makes latency observable end-to-end: `FetchHttpClient` measures
 * `durationMs` as wall-clock time around the whole `fetch()` call, so any
 * delay introduced anywhere in the composed dispatch chain is faithfully
 * reflected in the real metrics/latency percentiles the report reads from.
 * This interceptor always eventually calls the real `dispatch()` -- see
 * `simulatedTimeoutError`'s doc comment for why error injection lives
 * elsewhere.
 */
function createLatencyInterceptor(
  computeDelayMs: (opts: RequestTimingLookupInput) => number,
): Dispatcher.DispatcherComposeInterceptor {
  return (dispatch) =>
    (opts, handler): boolean => {
      const delayMs = computeDelayMs({ path: opts.path, method: opts.method, body: opts.body });
      if (delayMs <= 0) return dispatch(opts, handler);
      setTimeout(() => {
        dispatch(opts, handler);
      }, delayMs);
      return true;
    };
}

/** One `MockAgent` shared across every mocked request in a stress run. */
export function createSharedMockAgent(): MockAgent {
  const agent = new MockAgent();
  agent.disableNetConnect();
  return agent;
}
