# Proxy bandwidth measurement and cost benchmark — design

Date: 2026-08-20
Branch: `research/proxy-cost-benchmark`
Status: approved design, not yet implemented

## 1. Goal

Answer, with measured numbers rather than estimates:

1. How many bytes does one scrape actually cost on the wire?
2. How long does a given proxy plan's bandwidth allowance last?
3. How many proxies are needed to sustain a target RPM at an acceptable
   success rate?

The output is a cost model that can size a proxy plan. It is not a change to
how scraping works.

## 2. What we already know, measured

### The compression gap makes body-length estimates useless for cost

`HttpResponse.body` is a `string` produced by `response.text()`
(`fetch-http-client.ts:89`). Undici sends `accept-encoding` and decompresses
transparently, so measuring at the `HttpClient` boundary counts **decompressed**
bytes. Proxy vendors bill **wire** bytes.

Measured 2026-08-20:

| Target                          | Decoded | Wire (content-length) |  Ratio |
| ------------------------------- | ------: | --------------------: | -----: |
| `en.wikipedia.org` (gzip)       | 240,161 |                47,257 | 5.08:1 |
| `www.tiktok.com/embed/v2/` (br) | 315,960 |     chunked, unstated | ~5–8:1 |

A cost model built on decoded bytes overstates the bill by roughly the
compression ratio, which is the difference between "this plan lasts a week" and
"this plan lasts a month". This is why measurement happens at the dispatcher,
not at the `HttpClient` port.

> The `325 KiB/video` local figure in
> [apify-tiktok-comparison.md](../../apify-tiktok-comparison.md) is a decoded
> measurement and carries this same overstatement. That report labels it an
> estimate; this document quantifies by how much.

### The free tier is tighter than assumed

One TikTok scrape is two requests (embed + player API), and the embed response
alone is ~316 KB decoded. At an assumed 5–8:1 ratio that is roughly 40–65 KB of
wire traffic per scrape.

A 250 MB/month allowance therefore buys on the order of **4,000–6,000 scrapes**
— not a number to spend guessing at. Calibrating before running the full
benchmark is a hard requirement, not a nicety (§5).

### Per-proxy attribution already works, including for rotating pools

`InMemoryProxyPool.identify()` (`in-memory-proxy-pool.ts:349-370`) suffixes the
proxy id with a digest of the full URL when two entries share a host:port, so
entries on one gateway keep separate health rather than merging.

```
one bare gateway URL     → 1 pool entry  → no attribution
N session-scoped URLs    → N pool entries → full attribution
```

So the open question about rotating residential proxies is not "can we attribute
usage" but "does the vendor put a sticky session in the username". That reframes
the provider matrix in §6.

## 3. Constraints

- **Access:** Webshare free tier only — 10 static proxies, ~250 MB/month. No
  rotating-residential account, so that comparison cannot be measured in this
  task.
- **Production impact:** counting ships in `src/` but stays **off by default**
  behind an env flag. The flag-off path must be provably identical to today.
- **Scope:** the brief explicitly asks this not to become another large research
  project. Anything not needed to answer §1 is out.

## 4. Part A — wire-byte counting in `src/`

### Mechanism

Undici's dispatcher sees body chunks **before** `fetch()` decompresses them —
confirmed by undici shipping a separate opt-in `decompress` interceptor
(v7.29.0). Counting in a dispatcher interceptor therefore yields wire bytes.

```
socket ──▶ [counting interceptor] ──▶ ProxyAgent ──▶ fetch decompress ──▶ body
           counts compressed bytes                    (too late to count)
```

### New files

- `src/infrastructure/http/counting-dispatcher.ts` — an undici interceptor,
  composed onto a dispatcher with `.compose()`. Counts:
  - request bytes: request line + headers + body length from the dispatch opts
  - response header bytes: from the response-start callback
  - response body bytes: summed chunk lengths, pre-decompression
- `src/core/metrics/bandwidth.ts` — a `BandwidthSink` port
  (`record({ proxyId, host, requestBytes, responseBytes })`) plus aggregation:
  totals, per proxy, per host, and bytes-per-request.

> **Implementation note.** Undici v7 renamed the handler callbacks
> (`onResponseStart` / `onResponseData`, not `onHeaders` / `onData`), and the
> handler's methods live on its prototype — a naive `{...handler}` spread drops
> them and the request hangs. This was hit while prototyping. The wrapper must
> delegate explicitly rather than spread, and a test must cover a full
> request/response lifecycle through the interceptor to catch it.

### Modified files

- `src/app/composition.ts:144` (`createProxyAgentFactory`) — compose the
  interceptor onto each cached `ProxyAgent` when the flag is on. Untouched
  construction path when off.
- `src/config/env.ts` + `AppConfigSchema` — `METRICS_BANDWIDTH` (default
  `false`).
- `.env.example` — document the flag and that it is measurement-only.
- `src/core/runner/build-proxy-summary.ts` — byte columns on `ProxyUsageView`,
  populated only when counting is enabled, `null` otherwise.

### Attribution

No new plumbing needed: `HttpRequest.proxy` already carries the lease, and the
pool already keeps ids distinct per §2. The interceptor is constructed per
proxy target inside the factory, so the proxy id is captured in its closure.

## 5. Part B — the benchmark harness in `scripts/`

`scripts/proxy-bandwidth-benchmark.ts`, following the Apify harness conventions
(`scripts/` only, so `tsconfig.build.json` keeps it out of `dist/`).

### Two-stage run, because the budget is small

1. **Pilot** — a fixed small run (default 100 requests) that reports measured
   wire bytes per request and nothing else. Cheap enough to be wrong about.
2. **Full run** — sized from the pilot figure against a `--budget-mb` ceiling,
   and refused outright if the projection would exceed it. The benchmark must
   not be able to spend the month's allowance by accident; this is the same
   structural-refusal posture the Apify harness takes toward money.

`--budget-mb` defaults to **25** — a tenth of the monthly allowance, so a
benchmark run is affordable to repeat and a mistake costs a tenth of a month
rather than a month. A hard ceiling of 100 MB applies regardless of the flag.

### Reported

Per configuration: proxy count, concurrency, achieved RPM, success rate,
p50/p95 latency, proxy failures, wire bytes total and per request, bytes per
proxy.

Derived: cost per 1,000 and per 1,000,000 requests, days to exhaust the
allowance at a given RPM, and proxies required to sustain the target RPM.

Every derived figure states the measured input it came from. A projection to
500 RPM from a 10-proxy free-tier sample is an extrapolation and is labelled as
one.

## 6. Deliverable: the provider questionnaire

`docs/proxy-cost-benchmark.md` records the questions a vendor must answer before
their product can be evaluated, since rotation semantics are not comparable
across vendors:

- Does the exit IP rotate per request, per connection, per session, or on a
  timer?
- Can a session be pinned, and for how long?
- Is the exit IP observable to the client?
- Can concurrent requests share one exit IP?
- Are per-IP usage statistics exposed?
- Is billing on wire bytes, decoded bytes, or requests?

Plus the §2 finding that sticky-session-in-username is the property that makes a
rotating pool usable here at all.

## 7. Testing

All deterministic, no network, no proxy.

- A fake dispatcher feeds known chunks; counted bytes equal the fed bytes.
- A full request/response lifecycle passes through the interceptor unchanged —
  guards the v7 handler-delegation trap in §4.
- Compressed and decoded sizes diverge as expected, asserting the counter tracks
  the wire figure.
- Flag off composes no interceptor and leaves the dispatcher identical.
- Per-proxy attribution splits correctly across two proxy ids.
- Aggregation reports `null`, never `0`, for a metric it did not observe.
- The benchmark refuses a run whose projected bytes exceed `--budget-mb`.

## 8. Out of scope

- Rotating-residential measurement — no account. Questionnaire only.
- Any change to pool, lease, retry, or rate-limit behaviour.
- Reducing the 316 KB embed payload. It is a real finding and worth raising, but
  acquisition logic is not this task's to change.
- A measured 500 RPM claim. Free-tier data supports an extrapolation, not a
  verdict.

## 9. Open questions

- Is 500 RPM the real production target, or the brief's placeholder? It sets the
  acceptance bar but not the design.
- Does Webshare bill wire bytes or decoded bytes? The counter measures wire; if
  they bill decoded, the model needs both figures. The questionnaire asks.
- TLS handshake and framing bytes are billed by the proxy but are invisible to a
  dispatcher-level counter. Expected to be small and amortised over keep-alive
  connections; worth stating as a known undercount rather than silently ignoring.
