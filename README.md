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

Out of scope for v1 (explicitly): scheduling, database design, and bot-detection logic.

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
| `src/core/metrics`        | In-memory `MetricsCollector`, percentiles                                              |
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

| Variable                      | Default    | Meaning                                                                    |
| ----------------------------- | ---------- | -------------------------------------------------------------------------- |
| `LOG_LEVEL`                   | `info`     | `trace`…`fatal`, or `silent`. Logs go to stderr.                           |
| `SCRAPER_CONCURRENCY`         | `10`       | Jobs in flight at once                                                     |
| `SCRAPER_TARGET_RPM`          | `500`      | Requests-per-minute ceiling; `0` disables pacing                           |
| `SCRAPER_MAX_QUEUE_SIZE`      | `0`        | Max waiting jobs; `0` = unbounded                                          |
| `SCRAPER_REQUEST_TIMEOUT_MS`  | `15000`    | Per-attempt timeout                                                        |
| `RETRY_MAX_ATTEMPTS`          | `3`        | Attempts per URL including the first; `1` disables retries                 |
| `RETRY_INITIAL_DELAY_MS`      | `250`      | First backoff delay                                                        |
| `RETRY_MAX_DELAY_MS`          | `10000`    | Backoff ceiling                                                            |
| `RETRY_BACKOFF_FACTOR`        | `2`        | Growth multiplier                                                          |
| `RETRY_JITTER`                | `true`     | Full jitter, so a batch does not re-fire in lockstep                       |
| `OUTPUT_DIR`                  | `./output` | Where JSONL and run summaries are written                                  |
| `PROXY_POOL`                  | _(empty)_  | Comma/newline-separated `protocol://[user:pass@]host:port`. Empty = direct |
| `PROXY_MAX_FAILURES`          | `3`        | Consecutive failures before cooldown                                       |
| `PROXY_COOLDOWN_MS`           | `60000`    | How long a failed/blocked proxy is benched                                 |
| `SESSION_STORE_PATH`          | _(empty)_  | Path to an operator-supplied session file. Empty = anonymous               |
| `SESSION_MAX_FAILURES`        | `3`        | Consecutive failures before cooldown                                       |
| `SESSION_COOLDOWN_MS`         | `300000`   | How long a blocked session is benched                                      |
| `INSTAGRAM_POST_DOC_ID`       | current ID | Anonymous post metadata operation                                          |
| `INSTAGRAM_CLIPS_DOC_ID`      | current ID | Recent creator-Reels operation                                             |
| `INSTAGRAM_CLIPS_MAX_PAGES`   | `2`        | Maximum anonymous clips pages checked per candidate author                 |
| `INSTAGRAM_CLIPS_MAX_AUTHORS` | `3`        | Maximum primary/coauthor accounts checked per Reel                         |

**Credentials never live in source.** Proxy credentials are read from `PROXY_POOL` and
kept inside the in-memory `ProxyTarget`; everything user-facing (logs, metrics, run
summaries) uses a credential-free proxy id like `http://proxy-a.example.net:8000`.

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

## 7. Running the web UI

```bash
pnpm dev
```

Then open <http://localhost:5173>. The dashboard lets you pick a platform, paste or
upload a batch, set concurrency and target RPM, start a run, and watch state
(`idle → preparing → running → completed | failed`), live progress, recent results,
rejected input, the run summary, and a JSONL download.

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
are not retried, concurrency is respected, output failures are fatal). TikTok-specific
tests cover hydration parsing, anonymous HTTP behavior and platform error mapping.

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
retry statistics, proxy statistics and session burn/health statistics. Latency
percentiles use the **nearest-rank** method, so a reported p95 is
always an observed sample. Throughput counts completed work items only — retries are
reported separately and can never inflate it.

See [`data/examples/README.md`](data/examples/README.md) for a synthetic example,
including the case of the same video appearing twice with different `scraped_at` values.

## 12. Current limitations

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
- **Latency samples are kept in full** in the metrics collector — fine for runs of this
  size, would want a histogram for very long runs.

## 13. What remains to implement

1. Run the staged Instagram proxy benchmark at strict 50, 100, 250, and 500 logical RPM.
   Run-scoped caching reduced the direct 100-URL test from 223 to 133 raw calls, and a
   strict 15 RPM confirmation held at 14.18 RPM, but no proxy pool is configured yet.
2. Validate the authenticated Instagram fallback for Reels beyond the anonymous page and
   coauthor bounds using a dedicated local test session.
3. Resolve TikTok `vm.tiktok.com` / `vt.tiktok.com` short links and feed the final canonical
   URL back into output and de-duplication.
4. Validate the ~500 rpm target against a real proxy workload and tune concurrency, pacing and
   the retry policy from the measured run summaries.
