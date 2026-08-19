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
> It fails visibly instead of returning `ok` without an exact view count. TikTok short
> links are detected but are not resolved in this milestone.

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
`src/infrastructure`; ports live in core (`HttpClient`, `ProxyPool`, `SessionPool`,
`SnapshotSink`, `Logger`) and adapters live in infrastructure. Wiring happens in exactly
one place, [`src/app/composition.ts`](src/app/composition.ts).

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

| Variable                      | Default    | Meaning                                                                              |
| ----------------------------- | ---------- | ------------------------------------------------------------------------------------ |
| `LOG_LEVEL`                   | `info`     | `trace`…`fatal`, or `silent`. Logs go to stderr.                                     |
| `SCRAPER_CONCURRENCY`         | `10`       | Ceiling on jobs in flight at once. See [§5.1](#51-concurrency-rate-and-backpressure) |
| `SCRAPER_TARGET_RPM`          | `500`      | **Logical jobs** admitted per minute; `0` disables pacing                            |
| `SCRAPER_BURST`               | `0`        | Jobs admissible at once after idle; `0` = one second of target                       |
| `SCRAPER_HTTP_RPM_PER_HOST`   | `0`        | **Actual HTTP requests** per minute per host, retries included; `0` = off            |
| `SCRAPER_MAX_QUEUE_SIZE`      | `1000`     | Max waiting jobs before the producer waits; `0` = unbounded                          |
| `SCRAPER_REQUEST_TIMEOUT_MS`  | `15000`    | Per-attempt timeout                                                                  |
| `SCRAPER_POLL_INTERVAL_MS`    | `900000`   | Default gap between cycle starts in `--watch`; `0` = back-to-back                    |
| `RETRY_MAX_ATTEMPTS`          | `3`        | Attempts per URL including the first; `1` disables retries                           |
| `RETRY_INITIAL_DELAY_MS`      | `250`      | First backoff delay                                                                  |
| `RETRY_MAX_DELAY_MS`          | `10000`    | Backoff ceiling                                                                      |
| `RETRY_BACKOFF_FACTOR`        | `2`        | Growth multiplier                                                                    |
| `RETRY_JITTER`                | `true`     | Full jitter, so a batch does not re-fire in lockstep                                 |
| `OUTPUT_DIR`                  | `./output` | Where JSONL and run summaries are written                                            |
| `PROXY_POOL`                  | _(empty)_  | Comma/newline-separated `protocol://[user:pass@]host:port`. Empty = direct           |
| `PROXY_MAX_FAILURES`          | `3`        | Consecutive failures before cooldown                                                 |
| `PROXY_COOLDOWN_MS`           | `60000`    | How long a failed/blocked proxy is benched                                           |
| `PROXY_MAX_CONCURRENT`        | `8`        | Jobs sharing one proxy at a time; `0` = unlimited                                    |
| `PROXY_PROBATION_CONCURRENT`  | `1`        | Jobs on a proxy that has not succeeded yet, or whose last outcome failed             |
| `PROXY_CONNECT_TIMEOUT_MS`    | `3000`     | Undici connect-phase timeout per proxy; must be < `SCRAPER_REQUEST_TIMEOUT_MS`       |
| `SESSION_STORE_PATH`          | _(empty)_  | Path to an operator-supplied session file. Empty = anonymous                         |
| `SESSION_MAX_FAILURES`        | `3`        | Consecutive failures before cooldown                                                 |
| `SESSION_COOLDOWN_MS`         | `300000`   | How long a blocked session is benched                                                |
| `INSTAGRAM_POST_DOC_ID`       | current ID | Anonymous post metadata operation                                                    |
| `INSTAGRAM_CLIPS_DOC_ID`      | current ID | Recent creator-Reels operation                                                       |
| `INSTAGRAM_CLIPS_MAX_PAGES`   | `2`        | Maximum anonymous clips pages checked per candidate author                           |
| `INSTAGRAM_CLIPS_MAX_AUTHORS` | `3`        | Maximum primary/coauthor accounts checked per Reel                                   |

**Credentials never live in source.** Proxy credentials are read from `PROXY_POOL` and
kept inside the in-memory `ProxyTarget`; everything user-facing (logs, metrics, run
summaries) uses a credential-free proxy id like `http://proxy-a.example.net:8000`.

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

**Proxy capacity is `proxies x PROXY_MAX_CONCURRENT`.** Set to `0`, leases are
shared without limit and the global `concurrency` is the only bound, so adding
proxies spreads the same work over more IPs without raising throughput — and one
dead IP can absorb a whole batch. With the limit set (default `8`), a larger pool
genuinely scales. If `SCRAPER_CONCURRENCY` exceeds `proxies x limit`, the pool is
the binding constraint; the surplus shows up as `waits.proxy_acquire_ms`.

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

When proxies are configured, a run also writes `<name>.proxy-events.jsonl`: one row per
proxy **health transition** — never per request — recording `from`/`to` state, the reason
and error code, and `eligible_at`. That is what makes "proxy p3 went bad at 19:21 and was
back at 19:26" answerable after the fact; the summary only holds the end state, and the
pool itself only ever holds the present. The file is bounded by state changes rather than
by request volume, and a write failure disables the log with a warning rather than ending
the run — losing a scrape row is unacceptable, losing an observability row is not.

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

Two further sections make a run's wall clock attributable rather than mysterious:
`queue` (max depth, wait p50/p95/max) and `waits` (`admission_ms`,
`http_rate_limit_ms`, `proxy_acquire_ms`, `retry_backoff_ms`). Retry backoff is
recorded because it holds a concurrency slot while it sleeps, and an idle-looking
slot must always be explainable.

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
- **TikTok acquisition depends on undocumented public-page hydration JSON.** A payload
  shape change produces a visible `parse_error`; it never fabricates or substitutes metrics.
- **Short links are detected, not resolved.** `vm.tiktok.com` / `vt.tiktok.com` are
  flagged with `requiresResolution`; the TikTok scraper currently accepts canonical
  `/@handle/video/{numeric-id}` and `/@handle/photo/{numeric-id}` URLs.
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
  | Proxy health / cooldown | In-memory `Map`            | Shared registry — otherwise worker B keeps hitting an IP worker A just saw blocked |
  | Proxy leases            | Per-process counts         | Shared lease registry with TTL                                                     |
  | Work distribution       | One process over an array  | Real queue with visibility timeouts                                                |
  | Output                  | Append-only, at-least-once | Idempotency keys, once payouts depend on it                                        |

  `TaskQueue`, `RateLimiter`, `ProxyPool`, `SessionPool` and `SnapshotSink` are ports in
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
3. Resolve TikTok `vm.tiktok.com` / `vt.tiktok.com` short links and feed the final canonical
   URL back into output and de-duplication.
4. Validate the ~500 rpm target against a real proxy workload and tune concurrency, pacing
   and the retry policy from the measured run summaries. The continuous-run harness
   (§6.1) already sustains that rate against the placeholder scrapers; what remains is
   running it against real acquisition once a proxy pool is configured.
