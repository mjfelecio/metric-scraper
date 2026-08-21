# Stress-testing infrastructure

A local, deterministic, mocked-upstream load-testing harness for the scraper. It answers
one question before any real (rate-limited, detection-risky) TikTok/Instagram traffic is
spent: **does the scraper's own plumbing — concurrency, admission pacing, the proxy pool's
rotation/cooldown/earned-capacity model, retry backoff, bandwidth accounting, telemetry —
hold up at the required rate, or does it silently collapse while still reporting a green
summary?**

It is not, and does not try to be, a substitute for the take-home spec's real acceptance
run. See [§9](#9-relationship-to-the-real-acceptance-benchmark).

## 1. What actually runs

Everything except the network socket is the real production code path:

```
synthetic URLs → real UrlNormalizerRegistry → real ScrapeRunner
  → real ProxyPool / ProxyProvider (rotation, cooldown, earned capacity)
  → real RetryPolicy (backoff, attempt budget)
  → real TikTokScraper / InstagramScraper (unmodified parsers)
  → real FetchHttpClient + RateLimitedHttpClient
  → [mock: undici MockAgent instead of a real socket to tiktok.com/instagram.com]
  → real counting-dispatcher (bandwidth) + real MetricsCollector
  → real buildRunSummary
```

The only production code change anywhere in this codebase is one narrow, additive,
default-preserving seam: `buildRunner`'s options (`src/app/composition.ts`) gained an
optional

```ts
transport?: ((bandwidthSink: BandwidthSink) => HttpClient) | undefined;
```

Omitted, `buildRunner` is byte-for-byte identical to before this work — verified by
`tests/app/composition.test.ts`. Supplied, it replaces only the `FetchHttpClient`
construction; everything downstream (`RateLimitedHttpClient`, `ScrapeRunner`,
`ProxyProvider`, scrapers, retry policy) is unaware anything changed. This mirrors the
five test seams `ScrapeRunnerDeps` already had (`createQueue`, `rateLimiter`, `sleep`,
`now`, `createTimeoutSignal`) rather than introducing a new pattern.

### Why a real `undici.MockAgent`, not a stub `HttpClient`

Mocking at the `HttpClient` port (the obvious-looking seam) would bypass
`FetchHttpClient`, the real proxy dispatcher construction, and the wire-byte counting
interceptor — exactly the pieces item 11 below needs to be real. Instead, the mock sits
one layer lower: `src/stress/upstream/proxy-mock-dispatcher.ts` composes the _same,
unmodified_ `createCountingInterceptor` (`src/infrastructure/http/counting-dispatcher.ts`)
onto a `MockAgent`-backed dispatcher, exactly the way `composition.ts`'s
`createProxyAgentFactory` composes it onto a real `ProxyAgent`. Bandwidth telemetry
therefore reflects the _actual_ bytes of whatever the mock replied with — not a simulated
number.

`PROXY_POOL` entries can be arbitrary, unreachable strings (or real ones — see the safety
note below): the mock dispatcher never opens a socket to a proxy or a platform, so the real
`InMemoryProxyPool`/`StaticProxyProvider`/`RotatingResidentialProxyProvider` run for real
against fake targets.

## 2. Safety

There is no flag that reaches a real endpoint. The mock transport is unconditional — this
command is architecturally incapable of hitting `tiktok.com`/`instagram.com`, not merely
configured not to by default. Verified directly: this repo's own `.env` has a real
`PROXY_POOL` of ten real proxy IPs from earlier work, and running `stress-test` with it
present never touches them — the mock dispatcher is wired in below the point where a real
`ProxyAgent` would ever be constructed.

## 3. Running it

```bash
pnpm stress-test --profile baseline --duration 30s          # sanity check the pipeline
pnpm stress-test --profile acceptance --platform tiktok      # 500 rpm / 10 min, mocked
pnpm stress-test --profile acceptance --platform instagram
pnpm stress-test --profile acceptance --platform mixed
pnpm stress-test --profile sustained                         # ~1000 rpm / 20 min, mocked
pnpm stress-test --profile burst                              # warmup -> flood -> recovery
pnpm stress-test --profile failure-heavy                      # elevated 429/403/timeout mix
```

Equivalently `pnpm cli stress-test ...` (same command, registered on the main `scraper`
CLI). Every run prints a report to stdout (`--json` for machine-readable) and writes
`<outputDir>/stress-<profile>-<timestamp>.report.json` and the underlying
`stress-<timestamp>.jsonl` snapshot rows, next to the summaries the normal CLI writes.

Exit code reflects the verdict: `0` on `PASS`, `1` on `FAIL`. (This is the one place this
project's CLI does that — the batch/session commands treat individual scrape failures as
data, not a process failure, because their job is collecting data. A stress test's whole
purpose is being a pass/fail gate, e.g. in CI.)

### Flags

| Flag            | Meaning                                                                          |
| --------------- | -------------------------------------------------------------------------------- |
| `--profile`     | `baseline \| acceptance \| burst \| sustained \| failure-heavy`                  |
| `--platform`    | `tiktok \| instagram \| mixed` (default `mixed`)                                 |
| `--concurrency` | jobs in flight at once                                                           |
| `--target-rpm`  | overrides the profile's default rate (`0` = unpaced)                             |
| `--duration`    | overrides the profile's default duration, e.g. `10m`                             |
| `--total-jobs`  | overrides the injected-batch size (`burst` profile only)                         |
| `--ramp-up`     | climb to the target rate over this long, in a 5-step staircase (see §5)          |
| `--burst`       | token-bucket burst allowance                                                     |
| `--seed`        | deterministic scenario/latency seed (default: derived from the profile name)     |
| `--workload`    | overrides the profile's default scenario mix: `normal \| failure-heavy \| clean` |
| `--residential` | run in `rotating-residential` proxy mode with placeholder gateway credentials    |
| `--output-dir`  | where the report/snapshots are written                                           |
| `--json`        | print the report as JSON instead of the formatted block                          |
| `--no-progress` | suppress phase-by-phase progress lines                                           |
| `--log-level`   | structured log level (stderr)                                                    |

Automated tests for the harness itself: `pnpm test:stress` (excluded from the default
`pnpm test`, since these tests drive real concurrency and real multi-second
`AbortSignal.timeout` waits — still fully offline and deterministic).

## 4. Mock upstream scenarios

Deterministic given `(seed, id)` — same seed, same synthetic id, same outcome, every time,
independent of call order or concurrency (see the concurrency-correctness note in §6).

**TikTok** (`src/stress/upstream/tiktok-mock-upstream.ts`): `normal`, `embed_403`,
`embed_429`, `embed_500`, `embed_timeout`, `embed_not_found`, `embed_challenge`,
`player_403`, `player_429`, `player_500`, `player_timeout`, `retry_then_success` (fails the
embed call a configurable number of times, then succeeds — exercised through the _real_
`RetryPolicy`/backoff in `ScrapeRunner`, not a fake retry loop in the mock).

**Instagram** (`src/stress/upstream/instagram-mock-upstream.ts`): `fast_path` (post query
alone has `play_count`), `clips_page1`, `clips_page2`, `clips_deep` (found on a later
author), `clips_exhausted` (never found — exercises the authenticated media-info fallback
when a proxy-pinned session is configured, or `session_error` when none is), `post_403`,
`post_429`, `post_500`, `post_timeout`, `post_not_found`, `post_malformed` (invalid JSON),
`post_missing_fields` (valid JSON, missing a required field). Response bodies are the exact
shapes verified against `tests/platforms/{tiktok,instagram}-scraper.test.ts`'s own
fixtures, padded to a configurable size (default ~26 KB, matching the task's observed
25-28 KB/request range) so bandwidth telemetry exercises something realistic.

Root/CSRF bootstrap failure injection is deliberately out of scope: production memoizes it
per-proxy for the scraper instance's life, so it is a rare, proxy-scoped event rather than
a per-job one — modeling failures there would add real complexity for a corner nobody is
asking to stress.

### Workload profiles

`src/stress/workload/workload-profile.ts` defines the scenario-weight mixes:
`NORMAL_WORKLOAD_PROFILE` (mirrors the task brief's own example: TikTok 95% success / 2%
429 / 1% 403 / 1% timeout / 1% 500; Instagram similarly skewed toward `fast_path`/early
`clips` pages), `FAILURE_HEAVY_WORKLOAD_PROFILE` (elevated 429/403/timeout), and
`CLEAN_WORKLOAD_PROFILE` (100% success, minimal latency — the `baseline` profile's
default, for a fast pipeline sanity check).

## 5. Test profiles

| Profile         | Default rate / duration                                            | Purpose                                                                   |
| --------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `baseline`      | 30 rpm / 60s, clean workload                                       | Establish normal behavior with a fast, low-noise run                      |
| `acceptance`    | **500 rpm / 10 min** (`specification.txt` §6)                      | The primary local pass/fail benchmark — see §9                            |
| `sustained`     | **~1000 rpm / 20 min** (derived, see below)                        | Memory growth, queue stability, proxy health over a longer window         |
| `burst`         | warmup(30rpm/15s) → flood(unpaced, 300 jobs) → recovery(30rpm/30s) | Queue/proxy/concurrency behavior under a sudden spike, and recovery after |
| `failure-heavy` | 200 rpm / 120s, failure-heavy workload                             | Retry behavior, rotation, cooldown handling under elevated failure rates  |

**`acceptance`'s pass/fail window scales with `--duration`.** The required sustained-rate
window defaults to whatever the phase actually ran for (600s unless overridden), not
always a hardcoded 10 minutes — `pnpm stress-test --profile acceptance --duration 15s` for
a quick dev smoke check is judged against 15s, not silently against the full spec
requirement it was never given the time to meet. Run it at the real default duration for
the actual benchmark.

**`sustained`'s 1000 rpm is derived, not from the take-home spec.** The task's own stated
context — 300-500 new submissions/day, each polled every 15 minutes, retained for up to 30
days — means up to ~15,000 actively-polled submissions can exist in any 15-minute window,
which is roughly 1000 requests/minute steady state. That is a _more realistic_ production
load than the take-home's flat 500 rpm number, but it is informational context, not a hard
requirement: `acceptance`'s 500 rpm / 10 min remains the strict gate, because the brief
says to treat the exact spec number as the acceptance criterion.

**Ramp-up is a staircase, not a curve.** `ScrapeRunner.run()` takes one fixed `targetRpm`
for its whole call; there is no notion of a mid-run rate change. `--ramp-up <duration>`
therefore prepends 5 short phases climbing to 20/40/60/80/100% of the target rate before
the steady phase, rather than a smooth ramp. This is a deliberate scoping decision (see the
plan this feature was built from) — a true smooth ramp would need a second production
change to the rate limiter, which this work does not make.

## 6. Determinism and concurrency correctness

Every scenario decision is a pure function of `(seed, id)`, computed via `SHA-256` (an
earlier hand-rolled FNV-1a-style hash was measured to have pathologically poor avalanche
for this call shape — long, mostly-shared key prefixes like
`tiktok:7000000000000010` vs `...011` — to the point that the seed had _zero_ measurable
effect on the output; `crypto.createHash('sha256')` costs microseconds per call, which is
irrelevant next to a mocked HTTP round trip).

This matters under concurrency: the same URL scraped multiple times in one run (e.g. the
take-home spec's own acceptance criterion 5 — 20 URLs scraped 3 times) can have several
concurrent in-flight attempts for the same synthetic id. A design that decided scenarios
via shared mutable state (e.g. "the current scenario for this id") would let a fast
concurrent attempt's embed and player calls disagree with each other. The one exception is
TikTok's `retry_then_success`, which needs a small per-id occurrence counter (how many
times has _this id's_ embed endpoint been hit) — documented in
`tiktok-mock-upstream.ts` as having benign, non-correctness-affecting nondeterminism only
under heavy concurrency on a deliberately-repeated identical URL (which attempt happens to
succeed can shift by one; the job still deterministically succeeds or exhausts its
attempts).

Instagram's clips lookup carries a similar problem: a clips request only ever carries
`target_user_id` + `max_id`, never the shortcode being searched for, so the mock cannot key
its answer off the shortcode directly. It is solved without any state at all: synthetic
Instagram shortcodes are purely numeric by construction (`synthetic-input.ts`), and author
ids are synthesized as `${roleDigit}${shortcode}` — losslessly invertible on every request,
no lookup table needed. The authenticated media-info fallback (keyed by `mediaId`, not
shortcode) is decoded the same way, via the exact inverse of
`shortcodeToMediaId`'s base-64 positional encoding.

**Simulating "timeout" scenarios.** A `MockInterceptor.reply()` callback must return
synchronously and can only describe an HTTP _response_ — it cannot signal a transport
failure. Injecting an error from a custom compose interceptor sitting in front of
`MockAgent` (i.e. calling `handler.onError()` before ever calling the real `dispatch()`)
was tried and measured to hang silently: by the time a custom interceptor's handler
reaches it, it is already the new-style (`onRequestStart`/`onResponseError`) handler shape,
not the legacy (`onConnect`/`onError`) shape `MockAgent`'s own raw dispatch expects and
internally bridges. The fix: register a dedicated
`.replyWithError(simulatedTimeoutError(...))` interceptor (matched by a predicate that
independently recomputes the same scenario pick), ahead of the normal `.reply()`
registration for that endpoint — `MockAgent` tries interceptors in registration order. The
injected error carries `code: 'UND_ERR_CONNECT_TIMEOUT'`; `fetch()` wraps it into
`TypeError('fetch failed', {cause})`, and `FetchHttpClient`'s existing `toHttpError` walks
`.cause` for exactly that code, classifying the result `HttpError({code: 'timeout'})` —
the real timeout classification path, exercised without an actual multi-second wait.

## 7. Retryable failures recover on retry

Retryable failures (`embed_403`/`429`/`500`/`challenge`/`timeout`, `player_403`/`429`/`500`/
`timeout`, `post_403`/`429`/`500`/`timeout`) fail only on a synthetic id's **first** attempt
and succeed on every retry. This was not the original design, and the reason it changed is
itself a useful data point about what this harness can find:

Making a scenario a pure function of `(seed, id)` for _every_ call, including retries, was
measured to cascade a 10-proxy pool into 100% cooling within a 15-second run at the default
profile's ~5% TikTok failure rate. The mechanism: a "bad" id would fail identically no
matter which proxy retried it (three attempts, three different proxy leases, three
identical failures reported against three different proxies), so an ordinary ~5% content
failure rate ended up benching _every_ proxy that ever touched an unlucky id — a genuine
`proxy_exhaustion` finding, but a misleading one, because real transient rate-limiting is
usually a fact about the exit node a request went through, not the URL it requested (that's
the whole premise a retry is supposed to test). Fixed via a small per-id occurrence counter
(the same pattern `retry_then_success` already needed), with the same benign concurrency
caveat as §6. `embed_not_found`/`post_not_found`/`post_malformed`/`post_missing_fields`
stay permanent regardless of occurrence — they are non-retryable in the real scraper, and
unlike a transient block, a deleted or malformed post does not "come back" on a later,
independent scrape of the same URL (the acceptance-criterion-5 shape).

**The three `_timeout` scenarios needed a second, later fix (see FP-001 in
[`docs/failure-points.md`](failure-points.md)).** The occurrence counter above lives in each
platform module's closure and was originally only read from inside a `.reply()` callback —
fine for HTTP-status failures, since `.reply()` is exactly where the status is chosen. But a
simulated timeout is injected via a separate `.replyWithError(...)` interceptor (§6), and
`MockAgent` decides _which_ interceptor matches — including whether the error interceptor
matches at all — from that interceptor's own matching _predicate_, evaluated before any
`.reply()` callback ever runs. The predicate had no occurrence data to read yet, so
`embed_timeout`/`player_timeout`/`post_timeout` fired identically on every retry, never
recovering, unlike their HTTP-status siblings. Fixed by moving occurrence tracking out of
the reply callback and into `computeLatencyMs` — the one function in each mock-upstream
module guaranteed to run exactly once per dispatch, _before_ `MockAgent`'s own interceptor
matching — so both the error interceptor's predicate and the normal reply callback now read
from the same up-to-date counter. `createTikTokMockUpstream`/`createInstagramMockUpstream`
became factories for exactly this reason: the counter must be shared state constructed once
per run, not per call.

## 8. Measuring sustained throughput correctly

Two more issues surfaced while validating the acceptance profile end to end against the
real CLI, both now fixed, both worth knowing if this measurement ever looks wrong again:

**Sample on a fixed cadence, not once per completed job.** The load generator originally
called `ThroughputTimeline.record()` directly from `ScrapeRunner`'s `onProgress` callback,
which fires once per completed job — bursty by nature, since concurrent jobs tend to finish
close together and then leave a gap. `ThroughputTimeline.sustained()` derives each sample's
rate from the _wall-clock_ gap since the previous sample, so an irregular, low-density gap
reads as a throughput dip even when the run's overall rate is healthy. Fixed by sampling on
a fixed timer instead (mirroring `scrape-session.ts`'s own sampler): `onProgress` now only
updates a `latestProgress` variable, and a separate interval reads it on a fixed cadence.

**Size the cadence to the target rate.** Even on a fixed cadence, too fine an interval
relative to the target rate makes each window's _expected_ completion count so small that
ordinary scheduling jitter — which half-second a job happens to land in — dominates the
reading. The sample interval is now adaptive, sized off the run's steady/final phase's
`targetRpm` to aim for ~5 expected completions per window (clamped to [250ms, 2000ms]) —
see `adaptiveSampleIntervalMs` in `load-generator.ts`.

**A small tolerance on the sustained-window comparison.** Even with both fixes above, a
verified-healthy, 100%-success run paced at _exactly_ the target rate can still show
individual samples reading a hair under it (499 vs. a 500 target) purely from ordinary
`setInterval` timer jitter (a few ms per tick) — measured directly: a 15-second, 100%
-success run at exactly 500rpm produced samples of 499/500/501/499/500/... and a
`sustained()` window of ~3 seconds despite the run's own `requests_per_minute` reading
515.9 for the whole 15 seconds. `ThroughputTimeline.sustained()` itself is pre-existing
production code (also used by `scrape-session.ts`), so rather than changing its strict
`>=` comparison, `buildStressReport` calls it with `targetRpm * sustainedTolerance`
(default `0.97`) — a small enough margin to absorb sampling noise without weakening the
bar's intent, since a system that is _not_ actually keeping up won't cluster its per-sample
rate this tightly around the target to begin with. With this in place, that same 15-second
clean run at exactly 500rpm sustains ~29.4 of its own 30-second window — the residual ~0.6s
gap is the unavoidable warm-up before any job can complete at all (nothing can finish
before at least one round trip has elapsed from t=0), completely negligible at the real
600-second acceptance scale.

## 9. Relationship to the real acceptance benchmark

This harness proves the **infrastructure** can sustain the required rate without
collapsing. It does not, and cannot, prove anything about how TikTok/Instagram themselves
respond at volume — rate limits, block behavior, and detection are platform-side and only
observable against real traffic.

The take-home's actual acceptance criteria (100+ URLs per platform with real variation,
500 rpm sustained for 10+ minutes, ≥95% success, spot-checked accuracy) are demonstrated by
the **existing, unmodified** `--watch` session engine against real platforms and the
committed acceptance datasets — nothing here changes that path:

```bash
pnpm cli tiktok data/acceptance/tiktok-valid-100.txt \
  --watch --interval 0 --duration 10m --target-rpm 500 --concurrency 25

pnpm cli instagram data/acceptance/instagram-valid-100.txt \
  --watch --interval 0 --duration 10m --target-rpm 500 --concurrency 25
```

The intended order: run the mocked `acceptance` profile here first (fast, free, safe) to
catch a plumbing regression before spending real, rate-limited platform traffic on the
command above.

## 10. Telemetry cross-check

The task explicitly warns against conflating three different request concepts. A worked
example, verified in `tests/stress/upstream/telemetry-cross-check.test.ts` against the
_real_ `ScrapeRunner`:

```
Normal TikTok job (no retry):
  ProxyPoolStats.requests (leases)     1   -- one per ATTEMPT
  platform_http_requests (logical)     2   -- embed + player
  bandwidth.requests (wire)            2   -- equal here: no redirects, no retries

Retried TikTok job (fails once, then succeeds):
  ProxyPoolStats.requests (leases)     2   -- one per attempt: 2 attempts
  platform_http_requests (logical)     3   -- attempt 1: embed only (failed);
                                             attempt 2: embed + player
  bandwidth.requests (wire)            3   -- matches logical here: still no redirects

A followed redirect (any GET with redirect:'follow', which is every TikTok/Instagram
GET in this codebase except the manual-redirect GraphQL/media-info calls):
  one HttpClient.request() call        1   -- one logical call
  bandwidth.requests (wire)            2   -- one dispatch per hop
```

Proxy leases are always **≤** logical/wire requests (fewer attempts than the calls each
attempt makes); logical and wire requests are usually equal and diverge only when
`fetch()` follows a redirect within one call. All three numbers are real, verified against
the actual `ScrapeRunner`/`InMemoryProxyPool`/`BandwidthAggregator`, not asserted from
memory.

## 11. Known limitations

- **Ramp-up is a staircase, not a smooth curve** (§5) — a scoping decision, not an
  oversight.
- **Cross-phase latency percentiles are not computed.** A multi-phase run's report
  latency/proxy figures are the final/steady phase's own numbers, clearly labeled as such.
  This codebase's own summaries already state the reason elsewhere: "an average of p95s is
  not a p95," and there is no seam here to recompute one from raw per-job samples without a
  second production change.
- **Memory growth is a soft, informational signal only** — Node/V8 GC timing is too noisy
  for a hard pass/fail threshold, so it is reported as a `warn`-severity finding, never a
  `fail`.
- **"Open connections" is not meaningful under a mock transport** — no real sockets open.
  `ProxyPoolStats.totalInFlight` is reported as the practical proxy-side analog instead,
  documented explicitly as a substitution rather than presented as a real socket count.
- **Root/CSRF bootstrap failure injection is out of scope** for the Instagram mock (§4).
- **A `proxy_exhaustion` finding at 500rpm-scale volume with only a handful of proxies can
  be a real, correct result, not noise.** Measured directly: a `--platform tiktok
--target-rpm 500` run against the 10 proxies this repo's own `.env` happens to configure
  (from earlier manual proxy validation, unrelated to this feature) benched every proxy
  within 30 seconds at a realistic ~5% failure rate, purely from `PROXY_MAX_FAILURES=3`
  consecutive-failure cooldowns accumulating independently across proxies at that volume --
  even with §7's fix in place (retries do recover). That is the harness correctly answering
  the question it exists to ask: 10 proxies may be undersized for 500rpm sustained given
  the pool's default failure tolerance. Widen `PROXY_POOL`, raise `PROXY_MAX_FAILURES`, or
  both, and re-run before concluding a `FAIL` here means the _scraper_ is broken.
- **This demonstrates infrastructure capacity, not platform behavior.** See §9.
