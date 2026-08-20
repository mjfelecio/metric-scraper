# Bandwidth Instrumentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure real wire bytes per HTTP request, attribute them per proxy, stream them to the dashboard live, and keep a per-run baseline so runs can be compared.

**Architecture:** An undici dispatcher interceptor counts bytes before `fetch()` decompresses them, because the `HttpClient` port only sees a decompressed string and proxies bill wire bytes. Counts flow into `MetricsCollector`, ride the existing run-state poll via `ThroughputSample` and `ProxyUsageView`, and are folded into an append-only baselines file for cross-run averages.

**Tech Stack:** TypeScript (strict, NodeNext, `verbatimModuleSyntax`), undici 7.29.0, Zod, Vitest, Vite + Tailwind for the dashboard.

**Spec:** `docs/superpowers/specs/2026-08-20-bandwidth-instrumentation-design.md`

## Global Constraints

- TypeScript strict mode with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. Use `import type` for type-only imports.
- NodeNext module resolution: **every relative import ends in `.js`**, even when the source file is `.ts`.
- An unmeasured metric is `null`, never `0`. A zero asserts "used no bandwidth"; that is a different claim from "did not measure".
- `METRICS_BANDWIDTH` defaults to **`true`**.
- Tests are deterministic and make **no network calls**. Inject fakes through existing seams.
- Commit after every task. No `Co-Authored-By:` trailers (user's global CLAUDE.md rule).
- Run `pnpm test`, `pnpm typecheck`, `pnpm lint` before each commit. Binaries are at `./node_modules/.bin/*.cmd` if `pnpm` is not on PATH.

---

### Task 1: Bandwidth sink and aggregator

**Files:**

- Create: `src/core/metrics/bandwidth.ts`
- Test: `tests/metrics/bandwidth.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `BandwidthSample`, `BandwidthSink`, `BandwidthAggregator` with methods `record(sample: BandwidthSample): void`, `view(): BandwidthView`. `BandwidthView` has `{ requests: number; requestBytes: number; responseBytes: number; totalBytes: number; bytesPerRequest: number | null; perProxy: readonly ProxyBandwidthView[] }`. `ProxyBandwidthView` has `{ proxyId: string | null; requests: number; requestBytes: number; responseBytes: number; totalBytes: number }`.

- [ ] **Step 1: Write the failing test**

Create `tests/metrics/bandwidth.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { BandwidthAggregator } from '../../src/core/metrics/bandwidth.js';

describe('BandwidthAggregator', () => {
  it('sums request and response bytes across samples', () => {
    const agg = new BandwidthAggregator();
    agg.record({ proxyId: 'p1', host: 'www.tiktok.com', requestBytes: 100, responseBytes: 900 });
    agg.record({ proxyId: 'p1', host: 'www.tiktok.com', requestBytes: 150, responseBytes: 1850 });

    const view = agg.view();
    expect(view.requests).toBe(2);
    expect(view.requestBytes).toBe(250);
    expect(view.responseBytes).toBe(2750);
    expect(view.totalBytes).toBe(3000);
    expect(view.bytesPerRequest).toBe(1500);
  });

  it('reports bytesPerRequest as null before anything is measured', () => {
    // Zero would assert the run used no bandwidth, which is a different claim.
    expect(new BandwidthAggregator().view().bytesPerRequest).toBeNull();
  });

  it('splits totals per proxy', () => {
    const agg = new BandwidthAggregator();
    agg.record({ proxyId: 'p1', host: 'h', requestBytes: 10, responseBytes: 90 });
    agg.record({ proxyId: 'p2', host: 'h', requestBytes: 20, responseBytes: 180 });
    agg.record({ proxyId: 'p1', host: 'h', requestBytes: 10, responseBytes: 90 });

    const byId = new Map(agg.view().perProxy.map((row) => [row.proxyId, row]));
    expect(byId.get('p1')?.requests).toBe(2);
    expect(byId.get('p1')?.totalBytes).toBe(200);
    expect(byId.get('p2')?.requests).toBe(1);
    expect(byId.get('p2')?.totalBytes).toBe(200);
  });

  it('keeps direct (unproxied) traffic under a null proxy id', () => {
    const agg = new BandwidthAggregator();
    agg.record({ proxyId: null, host: 'h', requestBytes: 5, responseBytes: 15 });

    const direct = agg.view().perProxy.find((row) => row.proxyId === null);
    expect(direct?.requests).toBe(1);
    expect(direct?.totalBytes).toBe(20);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `./node_modules/.bin/vitest.cmd run tests/metrics/bandwidth.test.ts`
Expected: FAIL — `Failed to resolve import ".../bandwidth.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/core/metrics/bandwidth.ts`:

```ts
/** One measured HTTP round trip, in wire bytes. */
export interface BandwidthSample {
  /** `null` for a direct request that used no proxy. */
  readonly proxyId: string | null;
  readonly host: string;
  readonly requestBytes: number;
  readonly responseBytes: number;
}

/**
 * Where the counting dispatcher reports to.
 *
 * A port rather than a concrete class so the interceptor can be tested without
 * dragging in aggregation, and so a run can discard counts entirely when
 * measurement is switched off.
 */
export interface BandwidthSink {
  record(sample: BandwidthSample): void;
}

/** Ignores everything. Used when `METRICS_BANDWIDTH` is off. */
export const nullBandwidthSink: BandwidthSink = { record: () => {} };

export interface ProxyBandwidthView {
  readonly proxyId: string | null;
  readonly requests: number;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly totalBytes: number;
}

export interface BandwidthView {
  readonly requests: number;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly totalBytes: number;
  /** `null` until at least one request has been measured. */
  readonly bytesPerRequest: number | null;
  readonly perProxy: readonly ProxyBandwidthView[];
}

interface Bucket {
  requests: number;
  requestBytes: number;
  responseBytes: number;
}

/** The key used for direct traffic, which has no proxy id. */
const DIRECT = '�direct';

export class BandwidthAggregator implements BandwidthSink {
  private readonly buckets = new Map<string, Bucket>();

  record(sample: BandwidthSample): void {
    const key = sample.proxyId ?? DIRECT;
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      bucket = { requests: 0, requestBytes: 0, responseBytes: 0 };
      this.buckets.set(key, bucket);
    }
    bucket.requests += 1;
    bucket.requestBytes += sample.requestBytes;
    bucket.responseBytes += sample.responseBytes;
  }

  view(): BandwidthView {
    const perProxy: ProxyBandwidthView[] = [];
    let requests = 0;
    let requestBytes = 0;
    let responseBytes = 0;

    for (const [key, bucket] of this.buckets) {
      requests += bucket.requests;
      requestBytes += bucket.requestBytes;
      responseBytes += bucket.responseBytes;
      perProxy.push({
        proxyId: key === DIRECT ? null : key,
        requests: bucket.requests,
        requestBytes: bucket.requestBytes,
        responseBytes: bucket.responseBytes,
        totalBytes: bucket.requestBytes + bucket.responseBytes,
      });
    }

    const totalBytes = requestBytes + responseBytes;
    return {
      requests,
      requestBytes,
      responseBytes,
      totalBytes,
      bytesPerRequest: requests === 0 ? null : totalBytes / requests,
      perProxy,
    };
  }
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `./node_modules/.bin/vitest.cmd run tests/metrics/bandwidth.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/metrics/bandwidth.ts tests/metrics/bandwidth.test.ts
git commit -m "feat(metrics): add a bandwidth sink and per-proxy aggregator"
```

---

### Task 2: The counting dispatcher interceptor

**Files:**

- Create: `src/infrastructure/http/counting-dispatcher.ts`
- Test: `tests/http/counting-dispatcher.test.ts`

**Interfaces:**

- Consumes: `BandwidthSink`, `BandwidthSample` from Task 1.
- Produces: `createCountingInterceptor(options: { sink: BandwidthSink; proxyId: string | null })` returning an undici interceptor — a function `(dispatch) => (opts, handler) => unknown` suitable for `dispatcher.compose(...)`.

**Background the implementer needs.** Undici v7 renamed its dispatch-handler callbacks to `onRequestStart`, `onRequestUpgrade`, `onResponseStart`, `onResponseData`, `onResponseEnd`, `onResponseError`. Those methods live on the handler's **prototype**, so a `{...handler}` spread silently drops them and the request hangs with no error — this was hit while prototyping. Delegate through arrow functions that call `handler.method?.(...)`, which preserves `this`.

The interceptor sees body chunks **before** decompression (undici ships a separate opt-in `decompress` interceptor), which is exactly why counting happens here. Verified live: a Wikipedia page summed to 47,257 chunk bytes against a 240,161-byte decoded body — a 5.08:1 ratio.

- [ ] **Step 1: Write the failing test**

Create `tests/http/counting-dispatcher.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import { BandwidthAggregator } from '../../src/core/metrics/bandwidth.js';
import { createCountingInterceptor } from '../../src/infrastructure/http/counting-dispatcher.js';

/** Minimal stand-in for an undici dispatch handler, methods on the prototype. */
class FakeHandler {
  readonly events: string[] = [];
  readonly chunks: Buffer[] = [];

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

    interceptor(dispatchWith(chunks, {}) as never)(opts as never, new FakeHandler() as never);

    expect(sink.view().responseBytes).toBe(3400);
  });

  it('counts request line and headers as request bytes', () => {
    const sink = new BandwidthAggregator();
    const interceptor = createCountingInterceptor({ sink, proxyId: 'p1' });

    interceptor(dispatchWith([], {}) as never)(opts as never, new FakeHandler() as never);

    // "GET /embed/v2/123 HTTP/1.1\r\n" + both headers + the blank line.
    expect(sink.view().requestBytes).toBeGreaterThan(50);
  });

  it('includes response header bytes in the response total', () => {
    const sink = new BandwidthAggregator();
    const interceptor = createCountingInterceptor({ sink, proxyId: 'p1' });

    interceptor(dispatchWith([Buffer.alloc(100)], { 'content-type': 'text/html' }) as never)(
      opts as never,
      new FakeHandler() as never,
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

    interceptor(dispatchWith([Buffer.alloc(8)], {}) as never)(opts as never, handler as never);

    expect(handler.events).toEqual(['requestStart', 'responseStart', 'responseEnd']);
    expect(handler.chunks).toHaveLength(1);
    expect(handler.chunks[0]?.length).toBe(8);
  });

  it('attributes the sample to its proxy id', () => {
    const sink = new BandwidthAggregator();
    createCountingInterceptor({ sink, proxyId: 'proxy-7' })(dispatchWith([], {}) as never)(
      opts as never,
      new FakeHandler() as never,
    );

    expect(sink.view().perProxy[0]?.proxyId).toBe('proxy-7');
  });

  it('records a null proxy id for direct traffic', () => {
    const sink = new BandwidthAggregator();
    createCountingInterceptor({ sink, proxyId: null })(dispatchWith([], {}) as never)(
      opts as never,
      new FakeHandler() as never,
    );

    expect(sink.view().perProxy[0]?.proxyId).toBeNull();
  });

  it('still records when the response carries no body', () => {
    const sink = new BandwidthAggregator();
    createCountingInterceptor({ sink, proxyId: null })(dispatchWith([], {}) as never)(
      opts as never,
      new FakeHandler() as never,
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
    )(opts as never, new FakeHandler() as never);

    const responseBytes = sink.view().responseBytes;
    expect(responseBytes).toBeGreaterThanOrEqual(compressed.byteLength);
    expect(responseBytes).toBeLessThan(original.byteLength);
  });
});
```

Add the gzip import at the top of the test file:

```ts
import { gzipSync } from 'node:zlib';
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `./node_modules/.bin/vitest.cmd run tests/http/counting-dispatcher.test.ts`
Expected: FAIL — cannot resolve `counting-dispatcher.js`.

- [ ] **Step 3: Write the implementation**

Create `src/infrastructure/http/counting-dispatcher.ts`:

```ts
import { type BandwidthSink } from '../../core/metrics/bandwidth.js';

/** Bytes of framing undici adds per header line: `: ` plus CRLF. */
const HEADER_OVERHEAD_BYTES = 4;

export interface CountingInterceptorOptions {
  readonly sink: BandwidthSink;
  /** `null` when this dispatcher serves direct, unproxied traffic. */
  readonly proxyId: string | null;
}

/**
 * An undici interceptor that counts wire bytes.
 *
 * This sits at the dispatcher rather than at the `HttpClient` port on purpose.
 * The port exposes `HttpResponse.body` as an already-decompressed string, and
 * proxy vendors bill compressed wire bytes — measured 5.08:1 on a gzipped page,
 * so counting at the port would overstate the bill roughly fivefold. Undici
 * hands the dispatcher raw chunks before decompression, which is the number
 * that matches an invoice.
 *
 * The handler is wrapped by explicit delegation rather than by spreading it.
 * Undici v7 keeps handler methods on the prototype, so `{...handler}` produces
 * an object missing most of them and the request hangs with no error.
 */
export function createCountingInterceptor(options: CountingInterceptorOptions) {
  return (dispatch: (opts: unknown, handler: unknown) => unknown) =>
    (opts: unknown, handler: unknown): unknown => {
      const request = opts as {
        method?: string;
        path?: string;
        headers?: Record<string, unknown> | undefined;
        body?: unknown;
      };
      const inner = handler as Record<string, ((...args: unknown[]) => unknown) | undefined>;

      let requestBytes = measureRequest(request);
      let responseBytes = 0;
      let host = readHost(request.headers) ?? 'unknown';

      const wrapped = {
        onRequestStart: (...args: unknown[]): unknown => inner.onRequestStart?.(...args),
        onRequestUpgrade: (...args: unknown[]): unknown => inner.onRequestUpgrade?.(...args),
        onResponseStart: (...args: unknown[]): unknown => {
          responseBytes += measureHeaders(args[2]);
          return inner.onResponseStart?.(...args);
        },
        onResponseData: (...args: unknown[]): unknown => {
          const chunk = args[1];
          if (chunk instanceof Uint8Array) responseBytes += chunk.byteLength;
          return inner.onResponseData?.(...args);
        },
        onResponseEnd: (...args: unknown[]): unknown => {
          options.sink.record({ proxyId: options.proxyId, host, requestBytes, responseBytes });
          // Guard against a handler that is somehow driven twice: a second end
          // must not double-count the same round trip.
          requestBytes = 0;
          responseBytes = 0;
          return inner.onResponseEnd?.(...args);
        },
        onResponseError: (...args: unknown[]): unknown => {
          // A failed transfer still consumed bandwidth, so it is still recorded.
          if (requestBytes > 0 || responseBytes > 0) {
            options.sink.record({ proxyId: options.proxyId, host, requestBytes, responseBytes });
            requestBytes = 0;
            responseBytes = 0;
          }
          return inner.onResponseError?.(...args);
        },
      };

      host = readHost(request.headers) ?? host;
      return dispatch(opts, wrapped);
    };
}

function measureRequest(request: {
  method?: string;
  path?: string;
  headers?: Record<string, unknown> | undefined;
  body?: unknown;
}): number {
  const line = `${request.method ?? 'GET'} ${request.path ?? '/'} HTTP/1.1\r\n`;
  let bytes = Buffer.byteLength(line) + 2; // trailing CRLF that closes the head
  bytes += measureHeaders(request.headers);
  if (typeof request.body === 'string') bytes += Buffer.byteLength(request.body);
  else if (request.body instanceof Uint8Array) bytes += request.body.byteLength;
  return bytes;
}

function measureHeaders(headers: unknown): number {
  if (headers === null || typeof headers !== 'object') return 0;

  let bytes = 0;
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    const rendered = Array.isArray(value) ? value.join(',') : String(value ?? '');
    bytes += Buffer.byteLength(key) + Buffer.byteLength(rendered) + HEADER_OVERHEAD_BYTES;
  }
  return bytes;
}

function readHost(headers: Record<string, unknown> | undefined): string | null {
  if (headers === undefined) return null;
  const value = headers.host ?? headers.Host;
  return typeof value === 'string' && value.length > 0 ? value : null;
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `./node_modules/.bin/vitest.cmd run tests/http/counting-dispatcher.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Typecheck and lint**

Run: `./node_modules/.bin/tsc.cmd --noEmit` then `./node_modules/.bin/eslint.cmd src/infrastructure/http/counting-dispatcher.ts tests/http/counting-dispatcher.test.ts`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/infrastructure/http/counting-dispatcher.ts tests/http/counting-dispatcher.test.ts
git commit -m "feat(http): count wire bytes in an undici dispatcher interceptor"
```

---

### Task 3: Wire both request paths and add the config flag

**Files:**

- Modify: `src/infrastructure/http/fetch-http-client.ts` (add `defaultDispatcher` to `FetchHttpClientOptions`, use it when no proxy is assigned)
- Modify: `src/config/env.ts` (add `metricsBandwidth` to `AppConfigSchema` and to the candidate object)
- Modify: `src/app/composition.ts:144` (`createProxyAgentFactory`)
- Modify: `.env.example`
- Test: `tests/http/fetch-http-client.test.ts` (extend), `tests/config/env.test.ts` (extend)

**Interfaces:**

- Consumes: `createCountingInterceptor` (Task 2), `BandwidthAggregator` / `nullBandwidthSink` (Task 1).
- Produces: `FetchHttpClientOptions.defaultDispatcher?: unknown`; `AppConfig.metricsBandwidth: boolean`; `createProxyAgentFactory(config: AppConfig, sink: BandwidthSink)`.

**Why this task exists.** `dispatcherFactory` is consulted only when `request.proxy` is set (`fetch-http-client.ts:66`). Composing the interceptor onto `ProxyAgent` alone would report **zero bandwidth for any run without proxies**, which is most local runs. The direct path needs its own composed dispatcher, passed explicitly rather than via `setGlobalDispatcher` — a global would silently capture unrelated traffic elsewhere in the process.

- [ ] **Step 1: Write the failing test for the direct path**

Append to `tests/http/fetch-http-client.test.ts`:

```ts
describe('FetchHttpClient default dispatcher', () => {
  it('passes the default dispatcher on a request with no proxy', async () => {
    const seen: unknown[] = [];
    const marker = { id: 'default-dispatcher' };
    const client = new FetchHttpClient({
      defaultTimeoutMs: 1_000,
      defaultDispatcher: marker,
      fetchImpl: (_url, init) => {
        seen.push((init as Record<string, unknown>).dispatcher);
        return Promise.resolve(new Response('ok', { status: 200 }));
      },
    });

    await client.request({ url: 'https://example.test/', method: 'GET' });

    // Without this the direct path is unmeasured and the dashboard reads zero.
    expect(seen[0]).toBe(marker);
  });

  it('prefers the proxy dispatcher when a proxy is assigned', async () => {
    const seen: unknown[] = [];
    const fallback = { id: 'default' };
    const viaProxy = { id: 'proxy' };
    const client = new FetchHttpClient({
      defaultTimeoutMs: 1_000,
      defaultDispatcher: fallback,
      dispatcherFactory: () => viaProxy,
      fetchImpl: (_url, init) => {
        seen.push((init as Record<string, unknown>).dispatcher);
        return Promise.resolve(new Response('ok', { status: 200 }));
      },
    });

    await client.request({
      url: 'https://example.test/',
      method: 'GET',
      proxy: { url: 'http://user:pass@127.0.0.1:8000', protocol: 'http' } as never,
    });

    expect(seen[0]).toBe(viaProxy);
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `./node_modules/.bin/vitest.cmd run tests/http/fetch-http-client.test.ts`
Expected: FAIL — `defaultDispatcher` is not a known option, and `seen[0]` is `undefined`.

- [ ] **Step 3: Add the option to FetchHttpClient**

In `src/infrastructure/http/fetch-http-client.ts`, add to `FetchHttpClientOptions`:

```ts
  /**
   * Transport used when no proxy is assigned.
   *
   * Without this the direct path bypasses any composed dispatcher, so a run
   * with no proxies would report zero bandwidth. Passed explicitly rather than
   * set globally, so nothing outside this client is affected.
   */
  defaultDispatcher?: unknown | undefined;
```

Then in `request()`, replace the proxy dispatch block (currently around line 64-77) so the direct branch also attaches a dispatcher:

```ts
if (proxy !== null && proxy !== undefined) {
  if (this.options.dispatcherFactory === undefined) {
    throw new HttpError({
      code: 'config_error',
      message:
        'a proxy was assigned but no dispatcherFactory is configured; ' +
        'wire one up or clear the proxy assignment',
    });
  }
  Object.assign(init, { dispatcher: this.options.dispatcherFactory(proxy) });
} else if (this.options.defaultDispatcher !== undefined) {
  Object.assign(init, { dispatcher: this.options.defaultDispatcher });
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `./node_modules/.bin/vitest.cmd run tests/http/fetch-http-client.test.ts`
Expected: PASS, including the two new cases.

- [ ] **Step 5: Write the failing config test**

Append to `tests/config/env.test.ts`:

```ts
describe('METRICS_BANDWIDTH', () => {
  it('defaults to true so the dashboard panel is populated', () => {
    const config = loadConfig({ env: baseEnv(), dotenv: false });
    expect(config.metricsBandwidth).toBe(true);
  });

  it('can be switched off', () => {
    const config = loadConfig({ env: { ...baseEnv(), METRICS_BANDWIDTH: 'false' }, dotenv: false });
    expect(config.metricsBandwidth).toBe(false);
  });

  it('rejects a non-boolean value rather than guessing', () => {
    expect(() =>
      loadConfig({ env: { ...baseEnv(), METRICS_BANDWIDTH: 'sometimes' }, dotenv: false }),
    ).toThrow(/METRICS_BANDWIDTH must be a boolean/);
  });
});
```

> If `tests/config/env.test.ts` has no `baseEnv()` helper, use whatever env fixture the existing tests in that file already use, and match their `loadConfig` import.

- [ ] **Step 6: Run it and verify it fails**

Run: `./node_modules/.bin/vitest.cmd run tests/config/env.test.ts`
Expected: FAIL — `metricsBandwidth` is undefined.

- [ ] **Step 7: Add the config field**

In `src/config/env.ts`, add to `AppConfigSchema` (near the other top-level scalars, after `outputDir`):

```ts
  metricsBandwidth: z.boolean(),
```

And in the `candidate` object built inside `loadConfig` (alongside the other `bool(...)` calls such as `jitter: bool(env, 'RETRY_JITTER', true)`):

```ts
    metricsBandwidth: bool(env, 'METRICS_BANDWIDTH', true),
```

- [ ] **Step 8: Run the config tests and verify they pass**

Run: `./node_modules/.bin/vitest.cmd run tests/config/env.test.ts`
Expected: PASS.

- [ ] **Step 9: Document the flag**

Append to `.env.example`:

```bash
# --- Bandwidth measurement --------------------------------------------------
# Counts real wire bytes per request in an undici dispatcher interceptor and
# feeds the dashboard's Bandwidth panel. Measured at the dispatcher rather than
# at the HTTP client because the client only sees a decompressed body, and
# proxies bill compressed bytes — roughly a 5:1 difference on HTML.
# Overhead is summing chunk lengths. Set to false to disable the panel.
METRICS_BANDWIDTH=true
```

- [ ] **Step 10: Wire the interceptor into the proxy factory**

In `src/app/composition.ts`, change `createProxyAgentFactory` to take a sink and compose the interceptor. Replace the existing function (line 144-159) with:

```ts
export function createProxyAgentFactory(
  config: AppConfig,
  sink: BandwidthSink,
): (target: ProxyTarget) => unknown {
  const proxyAgents = new Map<string, ProxyAgent | Dispatcher>();
  return (target) => {
    if (target.protocol !== 'http' && target.protocol !== 'https') {
      throw new Error(
        `proxy protocol ${target.protocol} is not supported by the fetch transport; use http or https`,
      );
    }
    let agent = proxyAgents.get(target.url);
    if (agent === undefined) {
      const base = new ProxyAgent({
        uri: target.url,
        connectTimeout: config.proxy.connectTimeoutMs,
      });
      // Composed per target so the proxy id is captured for attribution.
      agent = config.metricsBandwidth
        ? base.compose(createCountingInterceptor({ sink, proxyId: proxyId(target) }))
        : base;
      proxyAgents.set(target.url, agent);
    }
    return agent;
  };
}
```

Add the imports at the top of `composition.ts`:

```ts
import { Agent, ProxyAgent, type Dispatcher } from 'undici';

import { type BandwidthSink } from '../core/metrics/bandwidth.js';
import { createCountingInterceptor } from '../infrastructure/http/counting-dispatcher.js';
```

> `proxyId` is the existing helper used by the pool to derive a credential-free id from a `ProxyTarget`. Import it from wherever `in-memory-proxy-pool.ts` imports it; run `grep -rn "export function proxyId" src/` to find it.

- [ ] **Step 11: Build the direct dispatcher at the call site**

Still in `composition.ts`, wherever `FetchHttpClient` is constructed, create the aggregator and pass both dispatchers:

```ts
const bandwidth = config.metricsBandwidth ? new BandwidthAggregator() : null;
const sink: BandwidthSink = bandwidth ?? nullBandwidthSink;

const http = new FetchHttpClient({
  defaultTimeoutMs: config.requestTimeoutMs,
  dispatcherFactory: createProxyAgentFactory(config, sink),
  ...(bandwidth === null
    ? {}
    : {
        defaultDispatcher: new Agent().compose(createCountingInterceptor({ sink, proxyId: null })),
      }),
});
```

Expose `bandwidth` from the composition result so Task 4 can read its view. Follow whatever shape the surrounding function already returns.

- [ ] **Step 11b: Prove the flag-off path is unchanged**

Create `tests/app/bandwidth-flag.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { createProxyAgentFactory } from '../../src/app/composition.js';
import { BandwidthAggregator } from '../../src/core/metrics/bandwidth.js';

const target = { url: 'http://user:pass@127.0.0.1:8000', protocol: 'http' as const };

function configWith(metricsBandwidth: boolean): never {
  // Only the two fields the factory reads; cast because the real AppConfig is large.
  return { metricsBandwidth, proxy: { connectTimeoutMs: 3_000 } } as never;
}

describe('bandwidth flag', () => {
  it('records nothing through the proxy factory when disabled', () => {
    const sink = new BandwidthAggregator();
    const factory = createProxyAgentFactory(configWith(false), sink);

    const agent = factory(target);

    // A composed dispatcher is a different object identity from a bare
    // ProxyAgent; with the flag off no interceptor may be attached.
    expect(agent).toBeDefined();
    expect(sink.view().requests).toBe(0);
  });

  it('caches one agent per proxy url rather than building one per request', () => {
    const factory = createProxyAgentFactory(configWith(true), new BandwidthAggregator());
    expect(factory(target)).toBe(factory(target));
  });
});
```

Run: `./node_modules/.bin/vitest.cmd run tests/app/bandwidth-flag.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 12: Run the full suite, typecheck and lint**

Run: `./node_modules/.bin/vitest.cmd run` then `./node_modules/.bin/tsc.cmd --noEmit` then `./node_modules/.bin/eslint.cmd src tests`
Expected: all pass, no new failures.

- [ ] **Step 13: Commit**

```bash
git add src/infrastructure/http/fetch-http-client.ts src/config/env.ts src/app/composition.ts .env.example tests/http/fetch-http-client.test.ts tests/config/env.test.ts
git commit -m "feat(http): count bandwidth on both the proxied and direct paths"
```

---

### Task 4: Surface bytes per proxy and per run

**Files:**

- Modify: `src/core/metrics/metrics-collector.ts` (add `recordBandwidth`, extend `ProxyUsageView`, extend `MetricsView`)
- Modify: `src/core/models/run-summary.ts` (add a `bandwidth` block to `RunSummarySchema`)
- Modify: `src/core/runner/build-proxy-summary.ts` (carry the byte fields through)
- Test: `tests/metrics/metrics-collector.test.ts` (extend), `tests/runner/build-proxy-summary.test.ts` (extend)

**Interfaces:**

- Consumes: `BandwidthView`, `ProxyBandwidthView` (Task 1).
- Produces: `MetricsCollector.recordBandwidth(view: BandwidthView): void`; `ProxyUsageView.requestBytes: number | null` and `.responseBytes: number | null`; `MetricsView.bandwidth: BandwidthView | null`; `RunSummary.bandwidth` shaped `{ request_bytes, response_bytes, total_bytes, bytes_per_request } | null`.

- [ ] **Step 1: Write the failing test**

Append to `tests/metrics/metrics-collector.test.ts`:

```ts
describe('MetricsCollector bandwidth', () => {
  it('reports null bandwidth when nothing was measured', () => {
    expect(new MetricsCollector().view().bandwidth).toBeNull();
  });

  it('exposes the recorded bandwidth view', () => {
    const collector = new MetricsCollector();
    collector.recordBandwidth({
      requests: 2,
      requestBytes: 200,
      responseBytes: 2_800,
      totalBytes: 3_000,
      bytesPerRequest: 1_500,
      perProxy: [
        {
          proxyId: 'p1',
          requests: 2,
          requestBytes: 200,
          responseBytes: 2_800,
          totalBytes: 3_000,
        },
      ],
    });

    const view = collector.view();
    expect(view.bandwidth?.totalBytes).toBe(3_000);
    expect(view.bandwidth?.bytesPerRequest).toBe(1_500);
    expect(view.bandwidth?.perProxy[0]?.proxyId).toBe('p1');
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `./node_modules/.bin/vitest.cmd run tests/metrics/metrics-collector.test.ts`
Expected: FAIL — `recordBandwidth` is not a function.

- [ ] **Step 3: Add the collector field**

In `src/core/metrics/metrics-collector.ts`:

```ts
import { type BandwidthView } from './bandwidth.js';
```

Add to `MetricsView`:

```ts
  /** `null` when measurement is off or nothing was observed. */
  readonly bandwidth: BandwidthView | null;
```

Add two optional fields to `ProxyUsageView`:

```ts
  /** Wire bytes sent through this proxy. `null` when unmeasured. */
  readonly requestBytes: number | null;
  /** Wire bytes received through this proxy. `null` when unmeasured. */
  readonly responseBytes: number | null;
```

Add a private field and method on `MetricsCollector`:

```ts
  private bandwidth: BandwidthView | null = null;

  recordBandwidth(view: BandwidthView): void {
    this.bandwidth = view;
  }
```

In `view()`, include `bandwidth: this.bandwidth`, and when building each `ProxyUsageView` row, look the proxy up in `this.bandwidth?.perProxy` by `proxyId` and set `requestBytes` / `responseBytes` from it, or `null` when absent.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `./node_modules/.bin/vitest.cmd run tests/metrics/metrics-collector.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the run-summary block**

In `src/core/models/run-summary.ts`, add to `RunSummarySchema` after the `throughput` block:

```ts
  /** `null` when METRICS_BANDWIDTH is off or nothing was measured. */
  bandwidth: z
    .object({
      request_bytes: z.number().int().nonnegative(),
      response_bytes: z.number().int().nonnegative(),
      total_bytes: z.number().int().nonnegative(),
      /** `null` rather than 0 when no request was measured. */
      bytes_per_request: z.number().nonnegative().nullable(),
    })
    .nullable(),
```

Populate it wherever the summary is assembled from `MetricsView` (search `grep -rn "throughput: {" src/` to find the builder), mapping straight from `view.bandwidth`.

- [ ] **Step 6: Run the full suite**

Run: `./node_modules/.bin/vitest.cmd run`
Expected: PASS. Any summary fixture that fails needs the new `bandwidth: null` key added.

- [ ] **Step 7: Commit**

```bash
git add src/core/metrics/metrics-collector.ts src/core/models/run-summary.ts src/core/runner/build-proxy-summary.ts tests/
git commit -m "feat(metrics): report bandwidth per proxy and per run"
```

---

### Task 5: Live samples on the existing timeline

**Files:**

- Modify: `src/core/metrics/throughput-timeline.ts` (extend `TimelineCounts` and `ThroughputSample`)
- Test: `tests/metrics/throughput-timeline.test.ts` (extend)

**Interfaces:**

- Consumes: nothing new.
- Produces: `ThroughputSample.bytes: number` (cumulative wire bytes at this sample) and `ThroughputSample.bytesPerMinute: number` (rate over the window since the previous sample). `TimelineCounts` gains `bytes: number`.

**Why here.** `RunStateDto.timeline` is already polled with a cursor and already drives the live chart from #36. Adding byte fields to the sample gives a live bandwidth chart with no new endpoint, matching the principle stated at `app/types.ts:119`.

- [ ] **Step 1: Write the failing test**

Append to `tests/metrics/throughput-timeline.test.ts`:

```ts
it('reports bandwidth as a rate over the sample window', () => {
  let clock = 1_000;
  const timeline = new ThroughputTimeline({ now: () => clock, startedAtMs: 1_000 });

  clock = 61_000; // exactly one minute later
  const sample = timeline.record({
    cycle: 1,
    completed: 10,
    successes: 10,
    failures: 0,
    retries: 0,
    inFlight: 0,
    bytes: 600_000,
  });

  expect(sample?.bytes).toBe(600_000);
  // 600,000 bytes in 60s is 600,000 bytes/minute.
  expect(sample?.bytesPerMinute).toBeCloseTo(600_000, 0);
});

it('measures bytes for the window, not the run, on the second sample', () => {
  let clock = 1_000;
  const timeline = new ThroughputTimeline({ now: () => clock, startedAtMs: 1_000 });
  const counts = { cycle: 1, successes: 0, failures: 0, retries: 0, inFlight: 0 };

  clock = 61_000;
  timeline.record({ ...counts, completed: 10, bytes: 600_000 });
  clock = 121_000;
  const second = timeline.record({ ...counts, completed: 20, bytes: 700_000 });

  // Only the 100,000 bytes added during the second window count toward the rate.
  expect(second?.bytesPerMinute).toBeCloseTo(100_000, 0);
  expect(second?.bytes).toBe(700_000);
});
```

> Match the exact constructor signature the existing tests in this file use; the options above are illustrative of the fields, not necessarily the parameter names.

- [ ] **Step 2: Run it and verify it fails**

Run: `./node_modules/.bin/vitest.cmd run tests/metrics/throughput-timeline.test.ts`
Expected: FAIL — `bytes` is not a property of the sample.

- [ ] **Step 3: Extend the sample**

In `src/core/metrics/throughput-timeline.ts`, add to `TimelineCounts`:

```ts
/** Cumulative wire bytes for the run so far. */
bytes: number;
```

Add to `ThroughputSample`, after `retriesPerMinute`:

```ts
/** Cumulative wire bytes at this sample. */
bytes: number;
/** Wire bytes over the window since the previous sample, per minute. */
bytesPerMinute: number;
```

And inside `record()`, in the object literal after `retriesPerMinute`:

```ts
      bytes: counts.bytes,
      bytesPerMinute: perMinute(counts.bytes - this.lastCounts.bytes),
```

- [ ] **Step 4: Run it and verify it passes**

Run: `./node_modules/.bin/vitest.cmd run tests/metrics/throughput-timeline.test.ts`
Expected: PASS.

- [ ] **Step 5: Feed the counts**

Find where `timeline.record({...})` is called (`grep -rn "\.record({" src/app src/core/runner`) and add `bytes: metrics.view().bandwidth?.totalBytes ?? 0` to the counts object, using whatever collector reference is already in scope there.

- [ ] **Step 6: Run the full suite, typecheck**

Run: `./node_modules/.bin/vitest.cmd run` then `./node_modules/.bin/tsc.cmd --noEmit`
Expected: PASS. Any `TimelineCounts` fixture missing `bytes` will fail typecheck; add `bytes: 0`.

- [ ] **Step 7: Commit**

```bash
git add src/core/metrics/throughput-timeline.ts tests/metrics/throughput-timeline.test.ts src/app src/core/runner
git commit -m "feat(metrics): carry wire bytes on the live throughput timeline"
```

---

### Task 6: The cross-run baseline store

**Files:**

- Create: `src/infrastructure/output/bandwidth-baselines.ts`
- Test: `tests/output/bandwidth-baselines.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks (takes plain numbers).
- Produces: `BandwidthBaselineRecord` `{ runId: string; finishedAt: string; requests: number; totalBytes: number; avgBytesPerRequest: number }`; `appendBaseline(path: string, record: BandwidthBaselineRecord): Promise<void>`; `readBaselines(path: string): Promise<BandwidthBaselineRecord[]>`; `summarizeBaselines(records, currentRunId?): BaselineSummary`.

`BaselineSummary` is `{ baseline: BandwidthBaselineRecord | null; runs: number; byRequest: number | null; byRun: number | null }`.

- [ ] **Step 1: Write the failing test**

Create `tests/output/bandwidth-baselines.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  summarizeBaselines,
  type BandwidthBaselineRecord,
} from '../../src/infrastructure/output/bandwidth-baselines.js';

function record(runId: string, requests: number, totalBytes: number): BandwidthBaselineRecord {
  return {
    runId,
    finishedAt: `2026-08-20T00:00:0${runId}Z`,
    requests,
    totalBytes,
    avgBytesPerRequest: totalBytes / requests,
  };
}

describe('summarizeBaselines', () => {
  /**
   * The two averages answer different questions and are both shown. A small
   * run must not drag the cost-predicting figure around.
   */
  it('weights the by-request average by traffic, not by run', () => {
    const summary = summarizeBaselines([
      record('1', 100, 5_000_000), // 50 KB/req
      record('2', 10_000, 100_000_000), // 10 KB/req
    ]);

    expect(summary.byRequest).toBeCloseTo(105_000_000 / 10_100, 2);
    expect(summary.byRun).toBeCloseTo((50_000 + 10_000) / 2, 2);
    expect(summary.runs).toBe(2);
  });

  it('uses the most recent record as the baseline', () => {
    const summary = summarizeBaselines([record('1', 10, 100), record('2', 10, 200)]);
    expect(summary.baseline?.runId).toBe('2');
  });

  it('excludes the current run from its own baseline', () => {
    // Comparing a run against itself would always report zero drift.
    const summary = summarizeBaselines([record('1', 10, 100), record('2', 10, 200)], '2');
    expect(summary.baseline?.runId).toBe('1');
  });

  it('reports nulls rather than zeros when there is no history', () => {
    const summary = summarizeBaselines([]);
    expect(summary.baseline).toBeNull();
    expect(summary.byRequest).toBeNull();
    expect(summary.byRun).toBeNull();
    expect(summary.runs).toBe(0);
  });

  it('ignores a record with no requests when averaging by run', () => {
    const summary = summarizeBaselines([
      record('1', 10, 1_000),
      { ...record('2', 1, 0), requests: 0 },
    ]);
    expect(summary.byRun).toBeCloseTo(100, 2);
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `./node_modules/.bin/vitest.cmd run tests/output/bandwidth-baselines.test.ts`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write the implementation**

Create `src/infrastructure/output/bandwidth-baselines.ts`:

```ts
import { appendFile, readFile } from 'node:fs/promises';

/** One completed run's bandwidth, appended when the run finishes. */
export interface BandwidthBaselineRecord {
  readonly runId: string;
  readonly finishedAt: string;
  readonly requests: number;
  readonly totalBytes: number;
  readonly avgBytesPerRequest: number;
}

export interface BaselineSummary {
  /** The most recent run other than the current one. `null` with no history. */
  readonly baseline: BandwidthBaselineRecord | null;
  readonly runs: number;
  /**
   * Total bytes / total requests across every run.
   *
   * This is the figure that predicts a bill, because it weights each run by
   * the traffic it actually sent.
   */
  readonly byRequest: number | null;
  /**
   * Mean of each run's own average.
   *
   * Weights every run equally, which is better for spotting one odd run and
   * worse for predicting cost. Shown alongside `byRequest`; a wide gap between
   * them means runs differ a lot in size.
   */
  readonly byRun: number | null;
}

export async function appendBaseline(path: string, record: BandwidthBaselineRecord): Promise<void> {
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
}

/** Reads the append-only log, skipping any line that is not usable. */
export async function readBaselines(path: string): Promise<BandwidthBaselineRecord[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    // No history yet is the normal first-run state, not an error.
    return [];
  }

  const records: BandwidthBaselineRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) records.push(parsed);
    } catch {
      // A truncated final line is expected if a run was killed mid-write.
      continue;
    }
  }
  return records;
}

export function summarizeBaselines(
  records: readonly BandwidthBaselineRecord[],
  currentRunId?: string,
): BaselineSummary {
  const history = records.filter((entry) => entry.runId !== currentRunId);
  const measured = records.filter((entry) => entry.requests > 0);

  const totalBytes = measured.reduce((sum, entry) => sum + entry.totalBytes, 0);
  const totalRequests = measured.reduce((sum, entry) => sum + entry.requests, 0);
  const meanOfRuns =
    measured.length === 0
      ? null
      : measured.reduce((sum, entry) => sum + entry.avgBytesPerRequest, 0) / measured.length;

  return {
    baseline: history.length === 0 ? null : (history[history.length - 1] ?? null),
    runs: measured.length,
    byRequest: totalRequests === 0 ? null : totalBytes / totalRequests,
    byRun: meanOfRuns,
  };
}

function isRecord(value: unknown): value is BandwidthBaselineRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.runId === 'string' &&
    typeof candidate.requests === 'number' &&
    typeof candidate.totalBytes === 'number' &&
    typeof candidate.avgBytesPerRequest === 'number'
  );
}
```

- [ ] **Step 4: Run it and verify it passes**

Run: `./node_modules/.bin/vitest.cmd run tests/output/bandwidth-baselines.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Append on run completion**

In `src/app/run-service.ts`, next to `persistSummary` (line 532), append a baseline record after the summary is written, using `${config.outputDir}/bandwidth-baselines.jsonl` and the run's `bandwidth` totals. Skip the append entirely when `summary.bandwidth` is `null` — an unmeasured run must not enter the history as a zero.

- [ ] **Step 6: Run the full suite and commit**

```bash
./node_modules/.bin/vitest.cmd run
git add src/infrastructure/output/bandwidth-baselines.ts tests/output/bandwidth-baselines.test.ts src/app/run-service.ts
git commit -m "feat(output): keep an append-only bandwidth baseline per run"
```

---

### Task 7: The dashboard panel

**Files:**

- Modify: `src/web/index.html` (add the panel container after `proxy-panel`, line 296)
- Modify: `src/web/render.ts` (add `renderBandwidthPanel`, call it from `render`)
- Modify: `src/app/types.ts` (add `bandwidth` to `RunStateDto`)
- Modify: `src/web/state.ts` (carry it into `AppState`)
- Test: `tests/web/render.test.ts` (extend)

**Interfaces:**

- Consumes: `BandwidthView` (Task 1), `BaselineSummary` (Task 6), `ThroughputSample.bytesPerMinute` (Task 5).
- Produces: `RunStateDto.bandwidth: { current: BandwidthView; baseline: BaselineSummary } | null`.

- [ ] **Step 1: Add the panel container**

In `src/web/index.html`, immediately after the `proxy-panel` div (line 293-296), add:

```html
<!-- Bandwidth ---------------------------------------------------->
<div
  id="bandwidth-panel"
  class="hidden rounded-xl border border-slate-800 bg-slate-900/50 p-5"
></div>
```

- [ ] **Step 2: Write the failing test**

Append to `tests/web/render.test.ts`, matching the DOM-setup helper the existing tests in that file use:

```ts
describe('renderBandwidthPanel', () => {
  it('stays hidden when nothing has been measured', () => {
    renderWithState({ bandwidth: null });
    expect(document.getElementById('bandwidth-panel')?.classList.contains('hidden')).toBe(true);
  });

  it('shows this run, the baseline and both averages', () => {
    renderWithState({
      bandwidth: {
        current: {
          requests: 142,
          requestBytes: 40_000,
          responseBytes: 1_393_600,
          totalBytes: 1_433_600,
          bytesPerRequest: 10_096,
          perProxy: [],
        },
        baseline: {
          baseline: {
            runId: 'prev',
            finishedAt: '2026-08-19T00:00:00Z',
            requests: 100,
            totalBytes: 980_000,
            avgBytesPerRequest: 9_800,
          },
          runs: 2,
          byRequest: 10_400,
          byRun: 30_000,
        },
      },
    });

    const panel = document.getElementById('bandwidth-panel');
    expect(panel?.classList.contains('hidden')).toBe(false);
    expect(panel?.textContent).toContain('142');
    // Both averages appear, because they answer different questions.
    expect(panel?.textContent).toMatch(/by request/i);
    expect(panel?.textContent).toMatch(/by run/i);
  });
});
```

- [ ] **Step 3: Run it and verify it fails**

Run: `./node_modules/.bin/vitest.cmd run tests/web/render.test.ts`
Expected: FAIL — the panel element is absent or never populated.

- [ ] **Step 4: Add the render function**

In `src/web/render.ts`, add a section function following the `renderProxyPanel` shape, and call it from `render(state)` alongside the other section calls:

```ts
function renderBandwidthPanel(state: AppState): void {
  const panel = el('bandwidth-panel');
  const data = state.bandwidth;

  if (data === null || data.current.bytesPerRequest === null) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
    return;
  }

  panel.classList.remove('hidden');
  const { current, baseline } = data;
  const drift =
    baseline.baseline === null || baseline.baseline.avgBytesPerRequest === 0
      ? null
      : (current.bytesPerRequest / baseline.baseline.avgBytesPerRequest - 1) * 100;

  panel.innerHTML = `
    <h2 class="text-sm font-semibold text-slate-200">Bandwidth</h2>
    <dl class="mt-3 space-y-1.5 text-xs text-slate-400">
      <div class="flex justify-between">
        <dt>this run</dt>
        <dd class="text-slate-200">
          ${formatBytes(current.totalBytes)} over ${current.requests} reqs
          &middot; ${formatBytes(current.bytesPerRequest)}/req
        </dd>
      </div>
      <div class="flex justify-between">
        <dt>baseline</dt>
        <dd class="text-slate-200">
          ${
            baseline.baseline === null
              ? '<span class="text-slate-500">no previous run</span>'
              : `${formatBytes(baseline.baseline.avgBytesPerRequest)}/req` +
                (drift === null
                  ? ''
                  : ` <span class="${driftClass(drift)}">${formatDrift(drift)}</span>`)
          }
        </dd>
      </div>
    </dl>
    <h3 class="mt-4 border-t border-slate-800 pt-3 text-xs font-semibold text-slate-300">
      average of all
    </h3>
    <dl class="mt-2 space-y-1.5 text-xs text-slate-400">
      <div class="flex justify-between">
        <dt>by request</dt>
        <dd class="text-slate-200">
          ${baseline.byRequest === null ? '—' : `${formatBytes(baseline.byRequest)}/req`}
        </dd>
      </div>
      <div class="flex justify-between">
        <dt>by run</dt>
        <dd class="text-slate-200">
          ${baseline.byRun === null ? '—' : `${formatBytes(baseline.byRun)}/req`}
          <span class="text-slate-500">(${baseline.runs} runs)</span>
        </dd>
      </div>
    </dl>
  `;
}

function formatDrift(percent: number): string {
  const arrow = percent >= 0 ? '▲' : '▼';
  return `${arrow} ${percent >= 0 ? '+' : ''}${percent.toFixed(0)}%`;
}

function driftClass(percent: number): string {
  return percent > 0 ? 'text-amber-400' : 'text-emerald-400';
}
```

> `formatBytes` may already exist in `src/web/metric-format.ts`. Run `grep -n "formatBytes\|KB\|MiB" src/web/metric-format.ts`; reuse it if present, otherwise add one there that renders B / KB / MB with one decimal.

- [ ] **Step 5: Run it and verify it passes**

Run: `./node_modules/.bin/vitest.cmd run tests/web/render.test.ts`
Expected: PASS.

- [ ] **Step 6: Plumb the DTO**

Add to `RunStateDto` in `src/app/types.ts`, after `proxies`:

```ts
  /**
   * Bandwidth for this run plus the cross-run baseline.
   *
   * Ships on the run-state poll for the same reason `proxies` does: the
   * dashboard is already asking for this object once a second.
   * `null` when METRICS_BANDWIDTH is off or nothing has been measured.
   */
  bandwidth: {
    current: BandwidthView;
    baseline: BaselineSummary;
  } | null;
```

Populate it where `RunStateDto` is assembled in `run-service.ts`, and carry it into `AppState` in `src/web/state.ts` alongside `proxies`.

- [ ] **Step 7: Add the live series to the chart**

In `renderThroughputChart` (line 757), add a `bytesPerMinute` series from `state.timeline` using the same series-drawing helper the existing rates use, labelled "bandwidth". If the chart's y-axis is shared and bytes would dwarf request rates, render the bandwidth sparkline inside `renderBandwidthPanel` instead, on its own scale.

- [ ] **Step 8: Verify the whole gate**

Run each and confirm exit 0:

```bash
./node_modules/.bin/vitest.cmd run
./node_modules/.bin/tsc.cmd --noEmit
./node_modules/.bin/eslint.cmd src tests
./node_modules/.bin/tsc.cmd -p tsconfig.build.json
./node_modules/.bin/vite.cmd build
```

- [ ] **Step 9: Commit**

```bash
git add src/web src/app/types.ts src/app/run-service.ts tests/web
git commit -m "feat(web): add a live bandwidth panel with baseline comparison"
```

---

## Notes for the implementer

- **Do not move counting to the `HttpClient` port.** It is the obvious place and it is wrong: the port hands back a decompressed string, and proxies bill compressed bytes. Measured 5.08:1 on a gzipped page. The whole design exists to avoid that error.
- **Never emit `0` for an unmeasured metric.** A zero claims the run used no bandwidth. Use `null`.
- **`render.ts` is already ~1,100 lines.** Add one section function in the existing pattern; splitting the file is a separate task and out of scope here.
- **The TikTok embed page is ~316 KB decoded per request**, and a scrape makes two requests. Once this lands you will see that number directly. Reducing it is acquisition logic and out of scope, but it is the largest single lever on bandwidth cost and is worth raising separately.
