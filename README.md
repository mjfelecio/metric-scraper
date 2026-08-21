# Metric Scraper

A batch pipeline for collecting **public engagement metrics** from TikTok videos and
Instagram Reels/video posts, as an append-only time series.

> ## Status: TikTok and Instagram canonical acquisition implemented
>
> `TikTokScraper` fetches TikTok's first-party public embed pages anonymously and parses
> their embedded hydration JSON. Canonical video and photo post URLs are accepted. It
> requires post id, views, likes, comments and shares;
> saves, author details and posting time remain nullable when TikTok omits them.
> A second first-party player request replaces rounded embed likes, comments and shares
> with exact integers. TikTok does not expose exact public view or save counts there, so
> views remain source-reported (and can be rounded for large posts) while saves are null.
>
> `InstagramScraper` uses anonymous first-party post and clips operations for exact
> likes, comments and Reel play counts. It checks a bounded two clips pages across the
> primary author and public coauthors before using proxy-bound media-info fallback.
> It fails visibly instead of returning `ok` without an exact view count. TikTok
> `vm.tiktok.com`, `vt.tiktok.com`, Instagram `/share/` links, and legacy
> `instagr.am` links are resolved into canonical post URLs before scraping.

---

## 1. What this is for

The system repeatedly scrapes a batch of video URLs and appends one JSONL row per
scrape. Rows are **observations, not entities**: scraping the same video twice on
purpose produces two rows, which is what makes the dataset a time series. Failures are
rows too — a request that fails is recorded with a status and an error, never dropped.

Out of scope for v1 (explicitly): database design and bot-detection logic.

The batch can also run **continuously** — repeating on a fixed-rate schedule — which is
what sustains a throughput target over a long window and what a production polling
cadence looks like. See [§6.1](#61-continuous-runs). Distributed scheduling is still out
of scope: this is one process with a timer, not a job queue.

## 2. Architecture

```
              ┌──────────────────────────────┐
   CLI ──────►│  Application / orchestration │◄────── Web dashboard (dev only)
              │  src/app, src/cli            │
              └───────────────┬──────────────┘
                              │
              ┌───────────────▼──────────────┐
              │  Core abstractions           │   models · scraper contract · runner
              │  src/core                    │   retry · rate-limit · concurrency
              └───────────────┬──────────────┘   metrics · input · url · output ports
                              │
              ┌───────────────▼──────────────┐
              │  Platform implementations    │   TikTok · Instagram
              │  src/platforms               │   (TikTok and Instagram live)
              └───────────────┬──────────────┘
                              │
              ┌───────────────▼──────────────┐
              │  Infrastructure              │   http · proxy · session
              │  src/infrastructure          │   output (JSONL) · logging · input files
              └──────────────────────────────┘
```

The load-bearing rule: **TikTok and Instagram implement the same `Scraper` contract, and
nothing above that layer knows anything platform-specific.** The runner schedules work,
retries it, leases it a proxy and a session, times it, and turns whatever comes back
into a row. A platform implementation only answers "what are this URL's metrics, or why
not".

Dependencies point inward. `src/core` imports nothing from `src/platforms` or
`src/infrastructure`; ports live in core (`HttpClient`, `ProxyProvider`, `ProxyPool`,
`SessionPool`, `SnapshotSink`, `Logger`) and adapters live in infrastructure. Wiring
happens in exactly one place, [`src/app/composition.ts`](src/app/composition.ts).

### Proxy modes

Requests go out through a `ProxyProvider`, chosen once by `PROXY_MODE` at the composition
root. Nothing downstream — not the runner, not the CLI — branches on which one is in play.

```
AppConfig ──► createProxyProvider() ──► ProxyProvider ──► ScrapeRunner
                      │
                      ├── static              ──► StaticProxyProvider  ──► InMemoryProxyPool
                      └── rotating-residential ──► RotatingResidentialProxyProvider
```

The port is deliberately narrow: `acquire` a lease for one attempt, `release` it with what
the attempt said about it, and `getStats`. What a lease _is_ differs by mode — a concrete
exit node under `static`, a gateway whose exit IP the provider chooses under
`rotating-residential` — and the port does not require it to be an IP either way.

The two differ in exactly one thing: what a failure means.

|                                                                                                                             | `static`                                                          | `rotating-residential`                                     |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| Endpoint                                                                                                                    | N concrete `IP:PORT` from `PROXY_POOL`                            | one gateway; the provider picks the exit IP                |
| Health model                                                                                                                | per-proxy cooldown, retirement, earned capacity                   | none — a failure never benches the gateway                 |
| `PROXY_MAX_FAILURES`, `PROXY_COOLDOWN_MS`, `PROXY_MAX_CONCURRENT`, `PROXY_PROBATION_CONCURRENT`, `PROXY_EXPLORATION_PERIOD` | apply                                                             | ignored                                                    |
| `PROXY_SOURCE_*`                                                                                                            | applies                                                           | ignored (warned at startup)                                |
| `PROXY_CONNECT_TIMEOUT_MS`                                                                                                  | applies                                                           | applies                                                    |
| Concurrency ceiling                                                                                                         | the pool's **earned** capacity, often below `SCRAPER_CONCURRENCY` | `SCRAPER_CONCURRENCY` alone                                |
| `proxies.per_proxy` rows                                                                                                    | one per proxy                                                     | one row for the **gateway**, not a roster                  |
| `acquire` may return `null`                                                                                                 | yes — nothing configured means go direct                          | never; a residential run cannot fall back to the origin IP |

Why residential has no health model: a failure through a rotating gateway is evidence about
one exit IP that will not be handed out again. Benching the gateway over it would take the
whole run offline, and cooling down an IP we have already lost accomplishes nothing. So
failures are counted for the summary and acted on by nothing. Rotation is the provider's
job; there is no IP-rotation logic in the scraper.

Retry is unaffected by the choice. It lives in the runner's attempt loop and nowhere else —
no provider retries internally, so the configured attempt budget is the real number of
requests. A proxy is leased per attempt, so a static retry naturally lands on a different
proxy and a residential retry on a different exit IP, without either provider arranging it.

**Comparing the two.** Run the same input under each mode and diff the summaries: `proxies.mode`
says which produced it, and totals, throughput, status breakdown, latency percentiles, retry
counts and error classification are all recorded identically. One caveat — the concurrency
ceilings differ (see the table), so unless `PROXY_MAX_CONCURRENT` is raised until the static
pool's earned `proxies.capacity` reaches `SCRAPER_CONCURRENCY`, a throughput comparison is
measuring pool capacity as much as proxy quality. Run and session summaries make that caveat
auditable: `throughput.concurrency` records the configured, input, admission and known proxy
ceilings, the resulting achievable concurrency, the minimum sampled proxy capacity, and
structured findings. Residential `capacity: null` is reported as **unknown**, never as zero
or unlimited.

Sticky sessions are not implemented. `ProxyRequestContext` carries the platform and attempt
number for a later session-id strategy to use, but nothing derives one today: providers
express sticky sessions as provider-specific username suffixes, and guessing that format
would be worse than leaving it out.

### Directory map

| Path                      | Responsibility                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `src/core/models`         | Snapshot, status, platform, errors, input, run summary — with Zod schemas              |
| `src/core/scraper`        | The `Scraper` contract and the ports it depends on (HTTP, proxy/session leases, pools) |
| `src/core/runner`         | `ScrapeRunner`, run-summary construction and terminal formatting                       |
| `src/core/retry`          | `RetryPolicy` — attempt budget, exponential backoff, retryability                      |
| `src/core/concurrency`    | `TaskQueue` port + p-queue implementation                                              |
| `src/core/rate-limit`     | rpm→queue pacing, token-bucket limiter                                                 |
| `src/core/metrics`        | In-memory `MetricsCollector`, percentiles, throughput timeline                         |
| `src/core/input`          | Pure input parser (text + JSON), shared by CLI and browser                             |
| `src/core/url`            | Generic URL normalization + normalizer registry                                        |
| `src/core/output`         | JSONL serialization and the `SnapshotSink` port                                        |
| `src/platforms/tiktok`    | **Where the TikTok implementation goes**                                               |
| `src/platforms/instagram` | **Where the Instagram implementation goes**                                            |
| `src/infrastructure`      | fetch client, proxy pool, session pool, JSONL file sink, pino logger                   |
| `src/config`              | Environment config and run-config file schemas                                         |
| `src/cli`                 | Commander CLI                                                                          |
| `src/web`                 | Vanilla-TS dev dashboard (+ the dev API plugin under `src/web/server`)                 |
| `tests`                   | Vitest suite                                                                           |
| `data/examples`           | Placeholder batch files and a synthetic sample output                                  |

## 3. Technology choices

| Choice                                                                             | Why                                                                                                         |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **TypeScript**, strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` | The output contract is the product; the type system should enforce it                                       |
| **Node ESM** with explicit `.js` import specifiers                                 | `tsc` output runs directly on Node, no bundler in the backend path                                          |
| **Zod**                                                                            | One definition serves as both the TS type and the runtime validator for the snapshot, config and run-config |
| **Pino**                                                                           | Structured logs, written to **stderr** so stdout stays clean for machine output                             |
| **Commander**                                                                      | Batteries-included CLI parsing, help text and validation                                                    |
| **p-queue**                                                                        | Concurrency _and_ interval-based pacing in one small, well-understood dependency                            |
| **dotenv**                                                                         | Local configuration without committing anything                                                             |
| **Vitest**                                                                         | Shares Vite's transform pipeline; no separate test toolchain                                                |
| **Vite + vanilla TS + Tailwind v4**                                                | The dashboard is a dev tool; no framework is warranted                                                      |

Deliberately **not** added: any frontend framework, a database, a scheduler, a job queue
service, an HTTP server framework, a metrics exporter, and `cheerio` (nothing parses HTML
yet, so it would be dead weight until acquisition is understood).

## 4. Setup

Requires Node ≥ 20.19 (developed on 22) and pnpm.

```bash
pnpm install
```

```bash
cp .env.example .env
```

`.env` is optional — every value has a working default, so a fresh clone runs as-is.

## 5. Environment variables

All are optional. See [`.env.example`](.env.example) for the annotated list.

| Variable                            | Default    | Meaning                                                                                  |
| ----------------------------------- | ---------- | ---------------------------------------------------------------------------------------- |
| `LOG_LEVEL`                         | `info`     | `trace`…`fatal`, or `silent`. Logs go to stderr.                                         |
| `SCRAPER_CONCURRENCY`               | `10`       | Ceiling on jobs in flight at once. See [§5.1](#51-concurrency-rate-and-backpressure)     |
| `SCRAPER_TARGET_RPM`                | `500`      | **Logical jobs** admitted per minute; `0` disables pacing                                |
| `SCRAPER_BURST`                     | `0`        | Jobs admissible at once after idle; `0` = one second of target                           |
| `SCRAPER_HTTP_RPM_PER_HOST`         | `0`        | **Actual HTTP requests** per minute per host, retries included; `0` = off                |
| `SCRAPER_MAX_QUEUE_SIZE`            | `1000`     | Max waiting jobs before the producer waits; `0` = unbounded                              |
| `SCRAPER_REQUEST_TIMEOUT_MS`        | `15000`    | Maximum duration of each individual outbound HTTP request                                |
| `TIKTOK_ATTEMPT_TIMEOUT_MS`         | `15000`    | Maximum duration of one complete TikTok attempt                                          |
| `INSTAGRAM_ATTEMPT_TIMEOUT_MS`      | `60000`    | Maximum duration of one complete Instagram attempt                                       |
| `SCRAPER_POLL_INTERVAL_MS`          | `900000`   | Default gap between cycle starts in `--watch`; `0` = back-to-back                        |
| `RETRY_MAX_ATTEMPTS`                | `3`        | Attempts per URL including the first; `1` disables retries                               |
| `RETRY_INITIAL_DELAY_MS`            | `250`      | First backoff delay                                                                      |
| `RETRY_MAX_DELAY_MS`                | `10000`    | Backoff ceiling                                                                          |
| `RETRY_BACKOFF_FACTOR`              | `2`        | Growth multiplier                                                                        |
| `RETRY_JITTER`                      | `true`     | Full jitter, so a batch does not re-fire in lockstep                                     |
| `OUTPUT_DIR`                        | `./output` | Where JSONL and run summaries are written                                                |
| `PROXY_MODE`                        | `static`   | `static` or `rotating-residential` — see [Proxy modes](#proxy-modes)                     |
| `PROXY_POOL`                        | _(empty)_  | _static_ · Comma/newline-separated `protocol://[user:pass@]host:port`. Empty = direct    |
| `PROXY_MAX_FAILURES`                | `3`        | _static_ · Consecutive failures before cooldown                                          |
| `PROXY_COOLDOWN_MS`                 | `60000`    | _static_ · How long a failed/blocked proxy is benched                                    |
| `PROXY_MAX_CONCURRENT`              | `8`        | _static_ · Ceiling on jobs sharing one proxy; earned, not granted. `0` = unlimited       |
| `PROXY_PROBATION_CONCURRENT`        | `1`        | _static_ · Floor every proxy starts at; a proxy that has never succeeded never leaves it |
| `PROXY_EXPLORATION_PERIOD`          | `5`        | _static_ · One lease in this many is reserved for an unproven proxy; `0` = off           |
| `PROXY_CONNECT_TIMEOUT_MS`          | `3000`     | Undici connect-phase timeout per proxy; must be < `SCRAPER_REQUEST_TIMEOUT_MS`           |
| `PROXY_ACQUIRE_WAIT_MS`             | `5000`     | _static_ · How long a job waits for a proxy before failing; `0` = fail immediately       |
| `PROXY_SOURCE_URL`                  | _(empty)_  | _static_ · ProxyScrape-style text endpoint for candidate proxies. Empty = feature off    |
| `PROXY_SOURCE_REFRESH_MS`           | `900000`   | How often the candidate list is refetched                                                |
| `PROXY_SOURCE_TARGET_CAPACITY`      | `0`        | Usable capacity to aim for, in slots; `0` follows `SCRAPER_CONCURRENCY`                  |
| `PROXY_SOURCE_MIN_CAPACITY`         | `5`        | Startup floor, and the floor below which the roster is never evicted                     |
| `PROXY_SOURCE_VALIDATE_CONCURRENCY` | `10`       | Simultaneous validation probes                                                           |
| `PROXY_SOURCE_VALIDATE_TIMEOUT_MS`  | `5000`     | Whole-probe budget; must exceed `PROXY_CONNECT_TIMEOUT_MS`                               |
| `PROXY_SOURCE_MAX_CANDIDATES`       | `5000`     | Ceiling on remembered candidates                                                         |
| `RESIDENTIAL_PROXY_PROTOCOL`        | `http`     | _residential_ · Gateway protocol; `http` or `https`                                      |
| `RESIDENTIAL_PROXY_HOST`            | _(empty)_  | _residential_ · Gateway host. Required when `PROXY_MODE=rotating-residential`            |
| `RESIDENTIAL_PROXY_PORT`            | _(empty)_  | _residential_ · Gateway port. Required in residential mode                               |
| `RESIDENTIAL_PROXY_USERNAME`        | _(empty)_  | _residential_ · Gateway username. Required in residential mode; never logged             |
| `RESIDENTIAL_PROXY_PASSWORD`        | _(empty)_  | _residential_ · Gateway password. Required in residential mode; never logged             |
| `SESSION_STORE_PATH`                | _(empty)_  | Path to an operator-supplied session file. Empty = anonymous                             |
| `SESSION_MAX_FAILURES`              | `3`        | Consecutive failures before cooldown                                                     |
| `SESSION_COOLDOWN_MS`               | `300000`   | How long a blocked session is benched                                                    |
| `INSTAGRAM_POST_DOC_ID`             | current ID | Anonymous post metadata operation                                                        |
| `INSTAGRAM_CLIPS_DOC_ID`            | current ID | Recent creator-Reels operation                                                           |
| `INSTAGRAM_CLIPS_MAX_PAGES`         | `2`        | Maximum anonymous clips pages checked per candidate author                               |
| `INSTAGRAM_CLIPS_MAX_AUTHORS`       | `3`        | Maximum primary/coauthor accounts checked per Reel                                       |

**Credentials never live in source.** Proxy credentials are read from `PROXY_POOL`
(static) or `RESIDENTIAL_PROXY_USERNAME`/`RESIDENTIAL_PROXY_PASSWORD` (residential) and
kept inside the in-memory `ProxyTarget`; everything user-facing (logs, metrics, run
summaries) uses a credential-free proxy id like `http://proxy-a.example.net:8000`. The
redacted config the dev API returns reports the gateway's host and port and never its
credentials.

**`PROXY_SOURCE_URL` layers a live candidate supply on top of `PROXY_POOL`, never
instead of it.** With it set, a background source periodically fetches a list of
candidate proxies, validates each one, and feeds survivors into the same pool the static
list uses — rotation, cooldown, probation and eviction all apply to them unchanged. Every
proxy reports which origin admitted it (`source: "config"` for `PROXY_POOL` entries, or
the source's name otherwise) in `ProxyHealth` and in run summaries — statically
configured proxies are exempt from the source's own eviction, so they behave exactly as
they did before this feature existed. Leave `PROXY_SOURCE_URL` empty to keep running on
`PROXY_POOL` alone.

**A candidate is admitted only once it has carried a real HTTPS request.** The probe
opens a CONNECT tunnel to a neutral endpoint (`www.gstatic.com/generate_204`), completes
a TLS handshake validated against the public trust store, and requires the endpoint's own
`204` back. Four things can fail and the run summary says which: `connect` (dead host),
`tunnel` (not a proxy at all — a web server answering `CONNECT` with `400`), `tls` (a
proxy intercepting our traffic with its own certificate) and `response` (a proxy
rewriting it). The trust store is deliberately not relaxed: a proxy presenting its own
certificate is one reading everything we send, which is a reason to reject it rather than
a certificate problem to work around.

This replaced a plain TCP connect probe, which was measured admitting proxies that could
not carry a single request — 42% of a live ProxyScrape list accept a TCP connection and
under a quarter of those complete an HTTPS round trip. The evidence, and the reasoning
about what should and should not be validated before admission, is in
[`docs/proxy-validation-measurement.md`](docs/proxy-validation-measurement.md); rerun it
with `pnpm diagnose:proxy`. Validation generates **no traffic to TikTok or Instagram**.

What the probe deliberately does not answer is whether a platform will serve a given exit
node. That is target policy, it changes minute to minute, and it stays where it was: with
the pool's health model on real jobs. Roughly two thirds of admitted proxies reach a
platform on their first try, so admission is evidence, not a guarantee.

**Known limitation: SOCKS candidates are accepted but cannot be used.** `PROXY_POOL` and
the candidate parser both accept `socks4://` and `socks5://` (`proxy-config.ts`), but the
undici transport supports only `http`/`https` and throws when handed anything else. That
throw escapes `FetchHttpClient`'s error mapping, so the attempt is classified `unknown` →
`neutral` and the proxy is never blamed, never cooled and never evicted. The canary probe
keeps such candidates out of a dynamic pool — a SOCKS server does not answer an HTTP
`CONNECT` — but a SOCKS entry written into `PROXY_POOL` by hand will still burn one job
per lease. Keep `&protocol=http` on `PROXY_SOURCE_URL` and use `http`/`https` entries.

**Supply is measured in slots, and eviction has a floor.** "Enough proxies" means the
sum of _earned, currently-leasable_ capacity — `proxies.capacity` in the run summary,
which counts a never-successful proxy at the probation floor and a benched one at zero.
That is the same unit as `SCRAPER_CONCURRENCY`, so the two can be compared directly, and
a roster of dead-but-unbenched proxies can no longer report a pool at full strength.
Replenishment admits validated candidates _before_ reaping hopeless ones, so a slot is
swapped rather than dropped and refilled; retired proxies are always reaped, but a
cooling one is kept once the roster is down to `PROXY_SOURCE_MIN_CAPACITY` entries that
could still come back, because a cooldown is the only path back when the candidate list
runs out. When nothing is leasable, `acquire` waits up to `PROXY_ACQUIRE_WAIT_MS` — but
only while waiting can help, meaning a cooldown due inside that budget or a source with
candidates left. With every proxy retired and no supply behind them it still fails at
once, and it never answers "go direct".

### 5.1 Concurrency, rate, and backpressure

These are three separate concerns, and collapsing them is a bug rather than a
simplification. An earlier version expressed the rate limit as task-queue pacing
(`intervalCap: 1` plus `carryoverConcurrencyCount`), which meant a single running
job blocked every other start: a configured concurrency of 10 executed strictly
one job at a time, and the run summary still reported `concurrency: 10`.

| Concern          | Knob                                              | Mechanism                     | What it bounds                               |
| ---------------- | ------------------------------------------------- | ----------------------------- | -------------------------------------------- |
| **Concurrency**  | `SCRAPER_CONCURRENCY`                             | Worker pool                   | Jobs in flight — sockets, memory, proxy load |
| **Rate**         | `SCRAPER_TARGET_RPM`, `SCRAPER_HTTP_RPM_PER_HOST` | Token bucket                  | How fast we start work / hit upstream        |
| **Backpressure** | `SCRAPER_MAX_QUEUE_SIZE`                          | Bounded queue, producer waits | Memory under a large input                   |

**Rate limiting is two-tier, on purpose.** `targetRpm` counts _logical jobs_ — one
URL is one unit however many HTTP calls or retries it costs. That keeps the
reported throughput figure meaningful (§11: throughput counts completed work
items, never retries). But it does not protect upstream, because one job is not
one request: TikTok issues two, Instagram up to three per bounded page/author,
and a retried job repeats all of them. `httpRpmPerHost` therefore limits the
actual egress, applied at the HTTP client so retries and multi-hop calls are
counted automatically.

```
1 job -> attempt 1 (2 hops) -> fail -> attempt 2 (2 hops) -> fail -> attempt 3 (2 hops)
       = 1 unit of targetRpm
       = 6 units of httpRpmPerHost
```

**Concurrency is a ceiling, not a target.** Sustained throughput obeys Little's
Law: `in-flight = rate x latency`. At the ~3.5s mean latency observed against
real TikTok URLs, a concurrency of 10 caps throughput at about 170 rpm no matter
what `targetRpm` says — reaching 500 rpm needs roughly 30, and a 13s mean latency
would need over 100. Set `concurrency` from measured latency and the target rate,
not by guessing:

```
required concurrency ~= (target_rpm / 60) x mean_latency_seconds
```

**Backpressure waits rather than fails.** When the queue is full the producer is
made to wait, so memory is bounded by `maxQueueSize` rather than by input size.
A full queue is not a run failure — dropping work would be a poor trade in a
system whose output feeds payouts.

**Proxy capacity is earned, and `proxies x PROXY_MAX_CONCURRENT` is only its
ceiling.** Every proxy starts at `PROXY_PROBATION_CONCURRENT` (default `1`),
doubles its slots on each success up to `PROXY_MAX_CONCURRENT`, and halves them
on each failure. What the pool can actually serve right now is the sum of that,
reported as `proxies.capacity` in the run summary — and _that_ is the number to
compare `SCRAPER_CONCURRENCY` against. If concurrency exceeds it, the pool is the
binding constraint and the surplus shows up as aggregate job-time in
`waits.proxy_acquire_total_ms`.

The ramp exists because the earlier model was binary: full concurrency for a
proxy whose last outcome was a success, one slot for everything else. Real
proxies fail intermittently, so nearly every proxy carried a recent failure
nearly always and pool capacity collapsed to _the number of usable proxies_. One
measured run had 23 proxies, a configured concurrency of 100, and a real ceiling
of 18 — with an 89%-success proxy throttled exactly as hard as a dead one.
Halving rather than collapsing keeps a good record worth something; keeping the
floor for proxies that have never succeeded keeps a dead IP to one job at a time.
Set `PROXY_MAX_CONCURRENT=0` to opt out entirely: leases are then shared without
limit, the global `concurrency` is the only bound, and only the never-succeeded
floor still applies.

**Rotation reserves a share of leases for unproven proxies.** Proxies that have
succeeded at least once are chosen by _normalised_ load (`inFlight / capacity`,
so traffic fills proxies in proportion to what they have earned) then
least-recently-used. One lease in `PROXY_EXPLORATION_PERIOD` goes instead to the
least-tried proxy that has never succeeded. Without that reservation a proxy
needs a success to be preferred but is scheduled last, so it can never earn one —
which is what made "more proxies" stop meaning "more capacity" here, and would
have neutralised the `PROXY_SOURCE_URL` supply layer entirely. The cost is
bounded twice: at most one lease in `N`, and at most `PROXY_MAX_FAILURES`
requests through any one bad proxy before it cools out of the eligible set.

**Proxy health is one model, used in three places.** Every attempt is classified
once — `classifyProxyOutcome` — and that single verdict drives rotation state and
the per-proxy numbers in the summary, so the two cannot disagree:

| Outcome                                | Verdict    | Effect                                               |
| -------------------------------------- | ---------- | ---------------------------------------------------- |
| `ok`, `not_found`, `private`           | success    | Healthy use; consecutive failures reset              |
| 429 / 403 (`rate_limited`, `blocked`)  | blocked    | Out of rotation for `PROXY_COOLDOWN_MS`              |
| HTTP 451 (`geo_blocked`)               | unsuitable | Retired for good after `PROXY_MAX_FAILURES` in a row |
| transport failures, other `http_error` | failure    | Cooldown after `PROXY_MAX_FAILURES` in a row         |
| `parse_error`, `cancelled`, bad input  | neutral    | Neither credited nor blamed                          |

`not_found` and `private` are facts about the URL, so they keep crediting the
proxy; a non-retryable `http_error` is a fact about the path taken, so it counts
against it. Retryability is a retry decision, never a health decision. HTTP 451
gets its own verdict because a cooldown cannot move an exit node to another
jurisdiction — repeat it and the proxy is retired rather than returning in 60 s
to fail the same share of every batch.

**A proxy is trusted only once it has worked.** Health is evaluated when a lease
is handed out, so an unproven proxy — or one whose last outcome was a failure —
takes one request at a time until it succeeds. That bounds what a dead IP can
absorb to roughly `PROXY_MAX_FAILURES` requests instead of however many jobs
happen to be in flight, without limiting proxies that are working.

**Every proxy is in exactly one state, and the state is published.** "Blocked" is
not a boolean: a proxy waiting out a cooldown, one that has never been tried, and
one retired for good need different answers from an operator. The state is derived
from the fields rotation already uses — never tracked separately — so what the
dashboard shows is what rotation actually did:

| State       | Meaning                                                               | Comes back?                    |
| ----------- | --------------------------------------------------------------------- | ------------------------------ |
| `untested`  | Configured, nothing sent through it yet                               | —                              |
| `healthy`   | Has succeeded, nothing unresolved since, has spare capacity           | —                              |
| `saturated` | Healthy but every slot is taken right now                             | As soon as a job finishes      |
| `probation` | Never succeeded, or failing since its last success; capped to one job | On its next success            |
| `cooling`   | Benched after `PROXY_MAX_FAILURES`, or a detected block               | At `eligible_at`               |
| `retired`   | Unsuitable exit node (repeated HTTP 451)                              | No — a jurisdiction has no TTL |

Alongside the state, each proxy reports when it was first and last used, when it
last succeeded and last failed, when it went bad (`unhealthy_since`) and when it is
due back (`eligible_at`), why (`block_kind`, `last_error_code`, a redacted
`last_reason`), how many jobs it is holding right now, and its request split by
platform and by error code. Pool-wide, `capacity` is the simultaneous proxied
requests the usable pool can serve, and `pool_exhausted` counts the times a job
found every proxy out at once — the difference between "the platform was slow" and
"we ran out of pool".

**Proxies are identified by a label, never by a credential.** Each entry gets `p1`…`pN`
from configuration order, shown next to the credential-free `protocol://host:port`.
Two entries on the same gateway host with different credentials — the usual shape of a
rotating residential pool — are kept apart by a short digest of the full URL
(`http://gate.example.net:8000#a1b2`); no part of the credential goes into the id, and
credentials are stripped from any reason text before it is stored.

Reading a bad run: failures concentrated on one or two proxies point at those exit
nodes, while failures spread evenly across a healthy pool — especially `parse_error`,
which is classified `neutral` and blames no proxy — point at a code change or at the
platform. The CLI and the dashboard both flag concentration when it is real, using the
same shared calculation.

Instagram sessions are supplied as a gitignored JSON file. `proxyId` must equal the
credential-free id of the sticky HTTP/HTTPS proxy in `PROXY_POOL`; use `null` only for
direct local testing. A session is never sent through an unmatched IP.

```json
{
  "sessions": [
    {
      "id": "instagram-test-1",
      "platform": "instagram",
      "proxyId": "http://proxy-a.example.net:8000",
      "cookie": "sessionid=...; csrftoken=...",
      "userAgent": null,
      "headers": {}
    }
  ]
}
```

Use a dedicated test account and browser-created cookies. Do not store Instagram
passwords or use a personal account.

### 5.2 Request and attempt timeouts

The request timeout and attempt timeout protect different boundaries. Each HTTP
call receives a fresh `SCRAPER_REQUEST_TIMEOUT_MS` budget from the transport.
The runner separately combines operator cancellation with the platform's attempt
timeout and passes that signal through the whole scrape workflow.

For example, an Instagram attempt may make a bootstrap request, a post request,
and several sequential clips requests. Those calls do not have to share one
15-second request timer, but the complete workflow must still finish within
`INSTAGRAM_ATTEMPT_TIMEOUT_MS` (60 seconds by default). TikTok keeps a shorter
15-second attempt ceiling because its normal workflow only needs two requests.
Retries start a new attempt and therefore receive a new attempt budget.

Keep the attempt timeout at least as large as the request timeout. Raising an
attempt timeout does not allow any single hung request to run longer, because
`SCRAPER_REQUEST_TIMEOUT_MS` still applies to each call.

## 6. Running the CLI

```bash
pnpm cli --help
```

Scrape a batch, forcing one platform:

```bash
pnpm cli tiktok data/examples/tiktok-urls.txt
```

```bash
pnpm cli instagram data/examples/instagram-urls.json
```

Mixed batches route per URL by host via a run config:

```bash
pnpm cli run config/run.example.json
```

Check an input file without scraping anything:

```bash
pnpm cli validate data/examples/tiktok-urls.txt
```

Useful options (all commands): `--concurrency`, `--target-rpm`, `--max-attempts`,
`--output-dir`, `--output-file`, `--format`, `--strict`, `--json`, `--no-progress`,
`--log-level`.

```bash
pnpm cli tiktok data/examples/tiktok-urls.txt --concurrency 25 --target-rpm 500 --json
```

Conventions: the run summary goes to **stdout** (human-readable, or JSON with `--json`);
progress and structured logs go to **stderr**. The process exits non-zero only on a
_run-level_ failure (bad config, unreadable input, unwritable output) — individual
scrape failures are data, so they do not fail the process.

After `pnpm build`, the CLI also runs from `dist`:

```bash
node dist/cli/index.js tiktok data/examples/tiktok-urls.txt
```

### 6.1 Continuous runs

A **cycle** is one pass over the batch; a **session** is a scheduled sequence of cycles.
`--watch` turns any scrape command into a session.

| Option                  | Meaning                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `-w, --watch`           | Repeat the batch instead of running it once                                                 |
| `--interval <duration>` | Time between cycle **starts**. Default `SCRAPER_POLL_INTERVAL_MS` (15m). `0` = back-to-back |
| `--duration <duration>` | Stop starting new cycles after this much wall clock                                         |
| `--max-cycles <n>`      | Stop after this many cycles                                                                 |

Any of the last three implies `--watch`. Durations accept `0`, `500ms`, `30s`, `15m`, `2h`;
a bare number is milliseconds.

```bash
# Sustain a target for ten minutes — the throughput acceptance run.
pnpm cli tiktok data/examples/tiktok-urls.txt \
  --watch --interval 0 --duration 10m --target-rpm 500 --concurrency 25
```

```bash
# Production polling cadence.
pnpm cli run config/run.example.json --watch --interval 15m
```

```bash
# Same code path, fast enough to smoke-test.
pnpm cli tiktok data/examples/tiktok-urls.txt --watch --interval 30s --max-cycles 5
```

The interval is measured **start to start** and computed from the session origin, so a
session does not drift: `--interval 15m` begins a cycle every fifteen minutes whatever the
cycles cost. A cycle that overruns its window does not push the schedule back — the next
one starts immediately and the summary records the shortfall as `lag_ms`.

**A session finishes and reports.** A cycle that throws is recorded, `cycles.failed` goes
up, and the session carries on; only an unwritable output is fatal. A watchdog flags a
cycle that stops making progress while work is still in flight. Ctrl-C stops after the
cycle in flight, and the summary is still written — a second Ctrl-C exits immediately.

Run configs carry the same settings (`watch`, `interval`, `duration`, `maxCycles`), and
precedence is unchanged: **CLI > run config > environment**.

### 6.2 Stress testing

`pnpm stress-test --profile acceptance --platform mixed` load-tests the real runner,
proxy pool, retry policy and scrapers against a deterministic, in-process mock upstream —
never real TikTok/Instagram traffic, and there is no flag that makes it otherwise. It
answers whether the scraper's own plumbing holds up at the required rate before any real
(rate-limited, detection-risky) platform traffic is spent confirming it. Named profiles:
`baseline`, `acceptance` (the take-home spec's own 500 rpm / 10 min numbers), `sustained`,
`burst`, `failure-heavy`. See [`docs/stress-testing.md`](docs/stress-testing.md) for the
full flag reference, mock scenario catalog, and how this relates to the real acceptance
benchmark (§6.1's `--watch` flow against `data/acceptance/*-valid-100.txt`, unchanged).

Behavior a run actually catches — capacity limits, cascades, misconfigurations, and
whether each one is a real problem or just a config choice — is tracked in
[`docs/failure-points.md`](docs/failure-points.md), kept up to date as new ones are found.

## 7. Running the web UI

```bash
pnpm dev
```

Then open <http://localhost:5173>. The dashboard lets you pick a platform, paste or
upload a batch, set concurrency and target RPM, start a run, and watch state
(`idle → preparing → running → completed | failed`), live progress, recent results,
rejected input, the run summary, and a JSONL download.

Tick **Continuous** to run a session instead, with the same three knobs as the CLI
(interval, duration, max cycles). A session adds a `waiting` state for the gap between
cycles — without it a fifteen-minute interval makes a healthy dashboard look hung — plus a
**throughput graph** and a session-summary download.

When a continuous session runs against **exactly one URL**, a **metric history** panel
appears: a live line chart of that video's views, likes, comments or shares across cycles,
one point per completed cycle, on a timestamp axis. It exists to make unusual movement
visible by eye — a sudden jump, a plateau, or one metric moving while the others do not —
and it deliberately makes no judgement of its own: there is no bot score and no anomaly
classifier, only the numbers and their changes.

Axis labels abbreviate (`153.2K`), but hovering a point shows the cycle number, the
timestamp, the **exact integer the scraper returned** (`153,247`) and the change since the
previous cycle (`+8,420`). That distinction matters: TikTok quantizes public view counts
at higher values, and the chart must show what was actually collected rather than round it
further. A cycle whose scrape failed is drawn as a break in the line rather than dropped,
so an outage cannot be mistaken for a flat metric, and the next cycle's change is measured
against the last cycle that had a value.

It reads the snapshot the runner already produced and the poll already carries — the same
row that goes to the JSONL — so there is one source of truth for the numbers, no second
transport and no extra request. The chart redraws only when a cycle actually completes,
and its markers are capped, so a session left running overnight costs no more per poll
than one that started a minute ago. Multi-URL sessions and one-shot runs never accumulate
or ship the series at all.

When proxies are configured, a **proxy pool** panel appears: usable / cooling / retired
counts, live capacity and how many jobs are in flight on how many proxies, then one row
per proxy with its state, in-flight load, request tallies, and a cooldown countdown for
anything benched. It answers the question a bad run actually raises — is the pool the
reason, or is something else — and flags it outright when failures are concentrated on a
few proxies or when the whole pool was out at once. The snapshot rides on the run-state
poll the dashboard already makes, sampled about once a second; it is not a second
transport and it never runs per job.

The graph plots the _instantaneous_ rate, derived from the delta between samples rather
than the cumulative average, because a running average smooths away exactly the dips a
soak test exists to find. It shows successes and failures shaded, a dashed reference line
at the configured target, markers at cycle boundaries, and retries as a separate dotted
line so they can never be misread as throughput. It is hand-rolled inline SVG — no chart
library was added.

It is a **development/observability tool, not a product UI**, so it runs inside the Vite
dev server: a small plugin ([`src/web/server/dev-api-plugin.ts`](src/web/server/dev-api-plugin.ts))
mounts a JSON API on `/api` and loads the backend through Vite's SSR loader. One process,
one command, and no second implementation of the wiring. `pnpm build:web` produces a
static bundle, but the API only exists under `pnpm dev`; if the dashboard ever needs to be
deployed separately, that plugin becomes a standalone HTTP server and nothing under
`src/app` changes.

## 8. Tests

```bash
pnpm test
```

```bash
pnpm test:watch
```

The Vitest suite covers the snapshot schema, config schema, text/JSON input parsing and its
failure modes, URL normalization, retry policy, metrics and percentiles, JSONL
serialization and append semantics, run-summary calculation, and the runner itself
(failures become rows, retries are counted separately from requests, permanent failures
are not retried, concurrency is respected, output failures are fatal).

Concurrency has its own guarantees, asserted rather than assumed: a configured 1, 5 and
10 each reach exactly that many jobs in flight; **full concurrency is still reached while
a rate limit is active** (the regression guard for the pacing bug described in §5.1); a
bounded queue applies backpressure without dropping work; the reported `max_observed`
never exceeds what actually ran; and several proxies are used simultaneously rather than
serializing on the pool. `tests/proxy/` covers LRU rotation, per-proxy capacity, cooldown
and recovery, and the refusal to fall back to a direct connection when every proxy is
benched. The JSONL sink is tested under concurrent writers, which is where its
open-once behaviour matters. TikTok-specific
tests cover hydration parsing, anonymous HTTP behavior and platform error mapping.

Continuous runs add: duration parsing, the fixed-rate scheduler (no drift, overrun
absorbed and reported, every stop condition, abort mid-wait), the throughput timeline
(instantaneous rate from deltas, bounded buffer, cursor paging, sustained-window
measurement), the session engine (**a throwing cycle does not stop the session**, all
cycles append to one file, retries stay out of throughput, cancellation still reports),
and the dashboard chart. The scheduler and timeline tests inject a fake clock, so nothing
waits on real time.

Automated tests do not call TikTok or Instagram. Platform implementations receive a stub
`HttpClient` through `ScrapeContext`, so the suite stays deterministic and offline.

`pnpm test:stress` runs the stress-testing harness's own suite (mock upstream scenarios,
workload determinism, the load generator, the report/verdict layer) — kept separate from
`pnpm test` because it drives real concurrency and real multi-second `AbortSignal.timeout`
waits, still fully offline. See [§6.2](#62-stress-testing).

## 9. Building

```bash
pnpm build          # tsc → dist/ (backend + CLI), vite → dist/web
pnpm build:server
pnpm build:web
pnpm typecheck
pnpm lint
pnpm format
```

## 10. Where the platform implementations go

| Platform  | Scraper                                                                                        | URL normalizer                                                                                               |
| --------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| TikTok    | [`src/platforms/tiktok/tiktok-scraper.ts`](src/platforms/tiktok/tiktok-scraper.ts)             | [`src/platforms/tiktok/tiktok-url-normalizer.ts`](src/platforms/tiktok/tiktok-url-normalizer.ts)             |
| Instagram | [`src/platforms/instagram/instagram-scraper.ts`](src/platforms/instagram/instagram-scraper.ts) | [`src/platforms/instagram/instagram-url-normalizer.ts`](src/platforms/instagram/instagram-url-normalizer.ts) |

TikTok anonymously fetches its first-party public embed page and player items response.
The embed parser reads `__FRONTITY_CONNECT_STATE__`; the player response supplies exact
likes, comments and shares to replace rounded embed values. The older
`__UNIVERSAL_DATA_FOR_REHYDRATION__` shape remains supported as a parser fallback. The
volatile payload parser is isolated from HTTP and orchestration.

Instagram bootstraps an anonymous CSRF context once per proxy, calls the current Polaris
post operation, and queries creator clips only when views are missing. Clips lookup is
bounded by configurable page and author limits, uses Instagram's `max_id` cursor, and
checks public coauthors. Successful clips pages are coalesced and reused within one run,
then discarded so a later time-series run fetches fresh counters. Reels outside those
bounds require a compatible session and use authenticated media-info. GraphQL document
IDs are configurable because they are undocumented and volatile.

## 11. Output contract

One JSON object per line, appended, UTF-8, keys in a fixed order:

| Field                                       | Type                                                  | Notes                                    |
| ------------------------------------------- | ----------------------------------------------------- | ---------------------------------------- |
| `platform`                                  | `"tiktok" \| "instagram"`                             |                                          |
| `video_id`                                  | `string \| null`                                      | Platform-native id; not a unique row key |
| `url`                                       | `string`                                              | The normalized URL that was requested    |
| `scraped_at`                                | ISO-8601 `string`                                     |                                          |
| `views` `likes` `comments` `shares` `saves` | `number \| null`                                      | `null` = not available, never `0`        |
| `author_handle`                             | `string \| null`                                      |                                          |
| `author_follower_count`                     | `number \| null`                                      |                                          |
| `posted_at`                                 | ISO-8601 `string \| null`                             |                                          |
| `status`                                    | `ok \| not_found \| private \| rate_limited \| error` |                                          |
| `error`                                     | `string \| null`                                      | `"<error_code>: <message>"` on failure   |
| `latency_ms`                                | `number`                                              | Whole attempt chain, including retries   |

Runs also write `<name>.summary.json` next to the JSONL: totals, success rate, actual
throughput, raw platform HTTP calls, latency p50/p95/max, status and error breakdowns,
retry statistics, proxy statistics and session burn/health statistics.

The proxy block carries a `mode` field naming the provider that produced it, which is
what makes two runs comparable. It also says how to read the rest of the block: under
`rotating-residential`, `per_proxy` holds a single row describing **the gateway, not a
physical proxy roster** — the exit IPs behind it are chosen per request and never visible
here, so `configured` is always `1` however many IPs were really used, and `cooling`,
`retired`, `saturated` and `capacity` stay at their inert values because nothing in that
mode can bench a gateway or ration its slots.

When `PROXY_SOURCE_URL` is configured, each per-proxy entry also carries a `source`
field (`"config"` or the source's name), and the proxy summary as a whole carries a
`source` block — candidates seen, validating, admitted, rejected, and the
`target_capacity` the supply was aiming at — so a source-fed run is auditable after the
fact the same way the static pool always was.

Under `PROXY_MODE=static` with proxies configured, a run also writes
`<name>.proxy-events.jsonl`: one row per proxy **health transition** — never per request — recording `from`/`to` state, the reason
and error code, and `eligible_at`. That is what makes "proxy p3 went bad at 19:21 and was
back at 19:26" answerable after the fact; the summary only holds the end state, and the
pool itself only ever holds the present. The file is bounded by state changes rather than
by request volume, and a write failure disables the log with a warning rather than ending
the run — losing a scrape row is unacceptable, losing an observability row is not. A
`rotating-residential` run writes no such file, and the reason is not an omission: there
are no health transitions to record, because nothing there ever benches the gateway.

**Concurrency is reported as a measurement, not as configuration.** A summary that
echoes the configured number back is how an effective concurrency of 1 hid behind a
configured 10 for an entire run, so `throughput.concurrency` is an object:

| Field          | Meaning                                                                           |
| -------------- | --------------------------------------------------------------------------------- |
| `configured`   | What was asked for                                                                |
| `max_observed` | High-water mark of jobs actually running at once                                  |
| `effective`    | `Σ(latency) / wall clock` — mean in-flight. **~1.0 means the run was sequential** |
| `utilization`  | `max_observed / configured`                                                       |
| `saturated`    | Whether the ceiling was ever actually reached                                     |

`effective` is the decisive number: it is derived from data already in the JSONL
(`scraped_at` + `latency_ms`), so any run's concurrency can be audited after the fact.
The CLI prints a warning whenever `max_observed < configured` while the queue backlog
was non-empty — capacity available but unused, which is the precise fingerprint of
accidental serialization.

Two further sections explain delay without pretending every measurement is wall-clock time.
`queue` describes enqueue-to-job-start delay (max depth plus wait count, total, mean,
p50, p95, and max). `waits` reports aggregate job-time as `admission_total_ms`,
`http_rate_limit_total_ms`, `proxy_acquire_total_ms`, and `retry_backoff_total_ms`.
Concurrent observations can overlap, so these totals can exceed run duration and must never
be used as wall-clock percentages. The older names without `_total` remain exact deprecated
aliases in run JSON. Admission occurs outside concurrency slots but can overlap running jobs;
HTTP limiting, proxy acquisition, and retry backoff occur within jobs, with backoff holding a
slot. Separately, `duration_ms` is run wall clock and latency is each job's end-to-end time.

Session JSON sums queue counts and totals, derives a weighted queue mean, and takes maximum
depth and maximum wait. It deliberately omits queue percentiles because per-cycle percentiles
cannot be combined. Its four canonical wait totals are sums across successful cycles.

A continuous session writes one file per session instead, plus a summary per cycle:

```
output/
  tiktok-<timestamp>.session.jsonl   # every row, all cycles, append-only
  tiktok-<timestamp>.session.json    # aggregate session summary
  cycles/
    tiktok-<timestamp>.cycle-001.json
    tiktok-<timestamp>.cycle-002.json
```

The session summary adds the schedule and its stop reason, per-cycle counts (including
how many overran their interval), the sampled throughput timeline, and **two** throughput
figures, because one number cannot serve both modes:

| Field                 | Meaning                                                                             |
| --------------------- | ----------------------------------------------------------------------------------- |
| `wall_clock_rpm`      | Requests over the whole session, idle gaps included. Deliberately tiny when polling |
| `active_rpm`          | Requests over time actually spent scraping, idle gaps excluded                      |
| `peak_rpm`            | Highest instantaneous rate observed                                                 |
| `sustained_target_ms` | Longest contiguous stretch at or above `target_rpm`                                 |

`sustained_target_ms` is the throughput requirement as a number: "held 500 rpm for ten
minutes" stops being an eyeballing exercise. Retries are reported only in their own
section and are never folded into any rpm figure. Session latency percentiles are
recomputed from the raw samples rather than averaging the cycles' percentiles, because an
average of p95s is not a p95. Latency percentiles use the **nearest-rank** method, so a reported p95 is
always an observed sample. Throughput counts completed work items only — retries are
reported separately and can never inflate it.

See [`data/examples/README.md`](data/examples/README.md) for a synthetic example,
including the case of the same video appearing twice with different `scraped_at` values.

## 12. Current limitations

- **The rotating residential mode is untested against a live gateway.** The provider,
  its configuration and its metrics are covered by unit tests, but nothing here has run
  against a paid residential account. Actual per-request IP rotation, gateway
  authentication, real throughput and latency, provider-side concurrent-session caps and
  rate limits, and whether the platforms treat residential exits differently from
  datacenter ones are all open questions that only a real account can answer.
- **Sticky sessions are not implemented** (see [Proxy modes](#proxy-modes)). The port
  carries the context a session strategy would need; the provider-specific username
  format it would encode is deliberately not guessed at.
- **Residential-specific automatic concurrency controls are deferred.** The shared
  diagnostics expose differing ceilings so cross-mode comparisons are auditable, while a
  static run remains bounded by earned pool capacity. Keep using `PROXY_MAX_CONCURRENT` and
  compare configured, known and achievable concurrency; no residential ceiling is assumed
  until a real provider limit is established.
- **Proxy health lives for one process.** Cooldowns and retirement are in-memory and
  session-scoped: a new run starts with a fresh pool. That is deliberate — a cooldown is a
  statement about a 30-second-old observation, and restoring yesterday's would bench
  proxies that have long since recovered. The durable record is the summary plus
  `*.proxy-events.jsonl`, which is what a past run should be read from.
- **Instagram uses undocumented first-party operations.** Document IDs and response
  shapes can change. A malformed response becomes a visible `parse_error`.
- **Instagram clips lookup is deliberately bounded.** The anonymous path checks at most
  two pages across three primary/coauthor accounts by default. Reels outside those bounds
  need a dedicated session; missing exact views are never considered successful.
- **Instagram shares and saves are usually unavailable to non-owners.** They remain
  `null` unless a tested response supplies an integer.
- **Instagram short links require a redirect request.** `/share/reel/{token}`,
  `/share/p/{token}`, `/share/{token}`, and legacy `instagr.am` post links use the same
  proxy and HTTP controls as scraping. Redirects are capped at five Instagram-owned hops
  and must end at a canonical `/reel/`, `/p/`, or `/tv/` URL.
- **TikTok acquisition depends on undocumented public-page hydration JSON.** A payload
  shape change produces a visible `parse_error`; it never fabricates or substitutes metrics.
- **TikTok short links require a redirect request.** `vm.tiktok.com` / `vt.tiktok.com`
  links are resolved through the configured proxy and HTTP controls before scraping. Redirects
  are capped at five hops, must remain under `tiktok.com`, and must end at a canonical
  `/@handle/video/{numeric-id}` or `/@handle/photo/{numeric-id}` URL. Unresolved links become
  visible failure rows; they do not stop the rest of a non-strict batch.
- **Proxy transport supports HTTP and HTTPS only.** SOCKS entries fail loudly rather
  than silently going direct and exposing the origin IP.
- **Run state is in-process.** The dashboard's run list is memory-only; the JSONL on disk
  is the durable artifact. No database, by design.
- **The web API is dev-only** (see §7).
- **Single process and direct-IP scale remain unvalidated.** The `TaskQueue` port is the
  seam for distributed execution, but the tested direct path did not approach 500 rpm.
  Continuous runs (§6.1) are a timer in that same process — there is no distributed
  scheduler, and a session does not survive a restart.
- **Every limit here is process-local.** This matters before deploying more than one
  worker, because neither knob is global — they multiply:

  ```
  4 workers x concurrency 10  = 40 concurrent requests   (not 10)
  3 workers x 500 rpm         = ~1500 rpm upstream       (not 500)
  ```

  | Guarantee               | Today                      | To make it global                                                                  |
  | ----------------------- | -------------------------- | ---------------------------------------------------------------------------------- |
  | Concurrency ceiling     | p-queue, in-process        | Distributed semaphore                                                              |
  | Job + HTTP rate         | In-memory token bucket     | Shared bucket behind the existing `RateLimiter` port                               |
  | Proxy health / cooldown | In-memory `Map` (static)   | Shared registry — otherwise worker B keeps hitting an IP worker A just saw blocked |
  | Proxy leases            | Per-process counts         | Shared lease registry with TTL                                                     |
  | Work distribution       | One process over an array  | Real queue with visibility timeouts                                                |
  | Output                  | Append-only, at-least-once | Idempotency keys, once payouts depend on it                                        |

  `TaskQueue`, `RateLimiter`, `ProxyProvider`, `SessionPool` and `SnapshotSink` are ports in
  `src/core`, so distributed implementations can be swapped in without touching
  `ScrapeRunner`. Dividing `targetRpm` by worker count is _not_ a substitute: it is
  brittle under autoscaling and silently wrong whenever a worker dies.

- **Latency samples are kept in full** in the metrics collector, and a session keeps its
  own copy so percentiles stay exact — fine for runs of this size, would want a histogram
  for very long ones. The throughput timeline is already bounded (2,000 samples).
- **A long final cycle can overshoot `--duration`.** The deadline stops new cycles from
  _starting_; one already in flight always finishes. The summary reports the duration
  actually observed.

## 13. What remains to implement

1. Run the staged Instagram proxy benchmark at strict 50, 100, 250, and 500 logical RPM.
   Run-scoped caching reduced the direct 100-URL test from 223 to 133 raw calls, and a
   strict 15 RPM confirmation held at 14.18 RPM, but no proxy pool is configured yet.
2. Validate the authenticated Instagram fallback for Reels beyond the anonymous page and
   coauthor bounds using a dedicated local test session.
3. Validate the ~500 rpm target against a real proxy workload and tune concurrency, pacing
   and the retry policy from the measured run summaries. The continuous-run harness
   (§6.1) already sustains that rate against the placeholder scrapers; what remains is
   running it against real acquisition once a proxy pool is configured.
