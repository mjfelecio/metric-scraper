# Bandwidth instrumentation and live dashboard — design

Date: 2026-08-20
Branch: `research/proxy-cost-benchmark`
Status: approved design, not yet implemented

## 1. Goal

Measure how many bytes the scraper actually sends and receives on the wire,
attribute them per proxy, show them live on the dashboard, and keep a per-run
average so runs can be compared against a baseline.

This is instrumentation and reporting. It does not change how scraping works,
and it does not attempt to choose a proxy provider — see §8.

## 2. What we already know, measured

### The compression gap makes body-length estimates useless

`HttpResponse.body` is a `string` produced by `response.text()`
(`fetch-http-client.ts:89`). Undici sends `accept-encoding` and decompresses
transparently, so measuring at the `HttpClient` boundary counts **decompressed**
bytes, while proxies bill **wire** bytes.

Measured 2026-08-20:

| Target                          | Decoded | Wire (content-length) |  Ratio |
| ------------------------------- | ------: | --------------------: | -----: |
| `en.wikipedia.org` (gzip)       | 240,161 |                47,257 | 5.08:1 |
| `www.tiktok.com/embed/v2/` (br) | 315,960 |     chunked, unstated | ~5–8:1 |

Counting therefore happens in an undici dispatcher interceptor, which sees
chunks before `fetch()` decompresses them — not at the `HttpClient` port, which
is the obvious-looking place and the wrong one.

> The `325 KiB/video` local figure in
> [apify-tiktok-comparison.md](../../apify-tiktok-comparison.md) is a decoded
> measurement and carries this same overstatement. That report labels it an
> estimate; this document quantifies by how much.

### Per-proxy attribution already works, including for rotating pools

`InMemoryProxyPool.identify()` (`in-memory-proxy-pool.ts:359`) suffixes the proxy
id with a digest of the full URL when two entries share a host:port, so entries
on one gateway keep separate health rather than merging.

```
one bare gateway URL     → 1 pool entry  → no attribution
N session-scoped URLs    → N pool entries → full attribution
```

Nothing new is needed for per-proxy bytes. It also means a rotating residential
pool is usable here as long as the vendor puts a sticky session in the username.

### The live transport already exists

`RunStateDto` (`app/types.ts:102`) is polled by the dashboard and already
carries `proxies: ProxyPoolStats` sampled about once a second, plus a
cursor-based `timeline: ThroughputSample[]` feeding the live chart added in #36.
Bandwidth ships on those existing channels. The comment at `types.ts:119` states
the principle: live data goes on the run-state poll rather than through a route
of its own.

## 3. Design

### 3.1 Counting — where the bytes come from

Undici's dispatcher sees body chunks **before** decompression, confirmed by
undici shipping a separate opt-in `decompress` interceptor (v7.29.0).

```
socket ──▶ [counting interceptor] ──▶ Agent/ProxyAgent ──▶ fetch decompress ──▶ body
           counts wire bytes                                (too late to count)
```

New:

- `src/infrastructure/http/counting-dispatcher.ts` — an undici interceptor
  composed with `.compose()`. Counts request line + headers + body from the
  dispatch opts, response header bytes at response-start, and summed chunk
  lengths for the body.
- `src/core/metrics/bandwidth.ts` — a `BandwidthSink` port
  (`record({ proxyId, host, requestBytes, responseBytes })`) plus aggregation:
  totals, per proxy, and bytes per request. The dispatcher captures `host`, but
  no current reader needs a per-host breakdown, so the aggregator does not
  retain one; adding that view is follow-up work if a real consumer appears.

> **Implementation note.** Undici v7 renamed the handler callbacks
> (`onResponseStart` / `onResponseData`, not `onHeaders` / `onData`) and the
> handler's methods live on its prototype — a naive `{...handler}` spread drops
> them and the request hangs with no error. This was hit while prototyping. The
> wrapper must delegate explicitly, and a test must drive a full
> request/response lifecycle through it to catch a regression.

### 3.2 Both request paths must be counted

`dispatcherFactory` is only consulted when `request.proxy` is set
(`fetch-http-client.ts:66`). Composing only onto `ProxyAgent` would report zero
bandwidth for any run without proxies.

- `composition.ts:144` (`createProxyAgentFactory`) — compose onto each cached
  `ProxyAgent`, capturing that proxy's id in the closure.
- `FetchHttpClient` — accepts an optional default dispatcher used when no proxy
  is assigned, composed the same way and recorded with a `null` proxy id.

The direct path takes an explicit dispatcher rather than `setGlobalDispatcher`,
which would silently capture unrelated traffic elsewhere in the process.

### 3.3 Flag

`METRICS_BANDWIDTH` in `AppConfigSchema` (`src/config/env.ts`), **default
`true`**. This reverses the earlier decision deliberately: when counting was a
research probe, opt-in was the safe default; now it backs a dashboard panel, and
a panel that is blank unless an env var is set is a broken feature. The flag
remains so it can be switched off. Overhead is summing chunk lengths.

### 3.4 Live and per-run reporting

Extended, not replaced:

- `ThroughputSample` (`core/metrics/throughput-timeline.ts:30`) gains `bytes`
  and `bytesPerMinute` for the window, alongside the existing per-minute rates.
  This is what makes the live chart possible with no new transport.
- `ProxyUsageView` (`core/metrics/metrics-collector.ts:28`) gains
  `requestBytes` and `responseBytes`.
- `RunSummary` gains run totals and average bytes per request.

Absent measurements are `null`, never `0`. A zero would assert that a run used
no bandwidth, which is a different claim from not having measured it.

Top-level totals also include direct, non-proxied requests. Because
`proxies.per_proxy` describes configured proxies only, summing those rows
legitimately yields zero rather than `bandwidth.total_bytes` for a direct run.

### 3.5 Baseline store

`output/bandwidth-baselines.jsonl` — append-only, one line per completed run:

```json
{
  "runId": "...",
  "finishedAt": "...",
  "requests": 142,
  "totalBytes": 1433600,
  "avgBytesPerRequest": 10096
}
```

Append-only JSONL matches the existing output idiom (`.gitignore:6` describes
scrape output as append-only and machine generated) and makes "average of all" a
fold over the file. The **baseline** is the most recent line other than the
current run.

### 3.6 Dashboard panel

`renderBandwidthPanel` in `src/web/render.ts`, following the existing
`renderProxyPanel` / `renderThroughputChart` section pattern:

```
Bandwidth
─────────────────────────────────────────────
live          14.2 KB/s        [sparkline]
this run      1.4 MB over 142 reqs   10.1 KB/req
baseline      9.8 KB/req  (last run)   ▲ +3%
─────────────────────────────────────────────
average of all
  by request  10.4 KB/req   (105 MB / 10,100)
  by run      30.0 KB/req   (mean of 2 runs)
```

Both averages are shown because they answer different questions. **By request**
(total bytes ÷ total requests) is the figure that predicts a bill, since it
weights each run by how much traffic it actually sent. **By run** (mean of each
run's average) weights every run equally and is better for spotting that one run
behaved unusually. A wide gap between them means runs differ a lot in size.

Baseline is displayed with the delta against the current run, so "this run is
using 3× more bandwidth than last time" is visible without arithmetic.

## 4. Testing

All deterministic, no network, no proxy.

- A fake dispatcher feeds known chunks; counted bytes equal the fed bytes.
- A full request/response lifecycle passes through the interceptor unchanged —
  guards the v7 handler-delegation trap in §3.1.
- Compressed and decoded sizes diverge as expected, asserting the counter tracks
  the wire figure rather than the decoded one.
- The direct (no-proxy) path is counted, not just the proxied one.
- Per-proxy attribution splits correctly across two proxy ids.
- Aggregation reports `null`, never `0`, for a metric it did not observe.
- Baseline fold: "by request" and "by run" averages differ as expected on runs of
  unequal size, and both match hand-computed values.
- Baseline selection ignores the current run's own line.
- Flag off composes no interceptor and leaves the dispatcher construction
  identical to today.

## 5. Out of scope

- Choosing a proxy provider, cost modelling, and the rotation-semantics
  questionnaire. Dropped from this task; the §2 findings remain as rationale if
  it is revived.
- Any change to pool, lease, retry, or rate-limit behaviour.
- Reducing the 316 KB embed payload. It is a real finding and the largest single
  lever on bandwidth cost, but acquisition logic is not this task's to change.
- Splitting `render.ts`, already ~1,100 lines. One section function is added in
  the existing pattern; the refactor deserves its own task.

## 6. Known limits

- This is **scraper-request bandwidth**, excluding proxy discovery and
  validation. With `PROXY_SOURCE_URL` enabled, the canary probe writes CONNECT,
  TLS, and HTTP directly through sockets and never reaches the bandwidth sink;
  those validation attempts consume unreported traffic and can number in the
  hundreds for a large candidate list.
- TLS handshake and framing bytes are billed by a proxy but are invisible to a
  dispatcher-level counter. Expected to be small and amortised across keep-alive
  connections, but this makes the figure a slight undercount — stated rather than
  silently ignored.
- Whether a given vendor bills wire or decoded bytes is unverified. The counter
  measures wire, which is the more common basis.
