# Comparing Apify with our own TikTok scraper

We already collect TikTok view counts. The open question is whether they are the
_public, rounded_ numbers — 1.2M rather than 1,234,567 — and whether a paid
provider would hand us anything finer. `pnpm compare:tiktok-apify` is the
measurement that answers it, built so the answer can be re-run rather than
re-argued.

It is a **benchmark and a decision tool**, not an integration. Nothing under
`src/` imports it, `tsconfig.build.json` compiles only `src/`, and the
production build contains none of it:

```bash
pnpm run build:server && find dist -name '*apify*'   # no matches
```

Apify is paid, and the account currently holds promotional credit only. Nothing
here starts an Actor as part of a test, an install hook, a build or a dry run.

---

## 1. The two modes

|                     | Dry run (default) | `--execute`                     |
| ------------------- | ----------------- | ------------------------------- |
| Apify requests      | none              | one run, capped                 |
| TikTok requests     | none              | one scrape per URL              |
| Cost                | none              | up to `--max-charge-usd`        |
| Needs `APIFY_TOKEN` | no                | **yes**, and refuses without it |
| Writes to `output/` | no                | yes                             |

Dry run is **entirely offline**. It parses the input, normalizes it, collapses
duplicates, and prints exactly what a paid run would submit — then stops. That
is a structural guarantee, not a promise: the dry-run branch returns before any
client is constructed, and a test asserts that both the Apify transport and the
scraper are never called.

There is no path from dry run to a paid run by accident. A missing token, a URL
count over the cap, an invalid charge cap or a malformed Actor id all **refuse**;
none of them fall back to running anyway, and none fall back to dry run while
reporting success.

## 2. Dry run

```bash
pnpm compare:tiktok-apify -- data/examples/tiktok-apify-smoke.txt
```

```text
DRY RUN — no Apify request was made and nothing was charged.

  actor:              clockworks/tiktok-scraper  (path id: clockworks~tiktok-scraper)
  billable URLs:      4 of a permitted 5
  charge cap:         $0.25
  duplicates dropped: 1
  rejected inputs:    0

  URLs that would be submitted:
    - https://www.tiktok.com/@emrys8473/video/7643585712641559841
    …

  Actor input (redacted):
    { "postURLs": [...], "shouldDownloadVideos": false, "aiVideoDescription": false,
      "downloadSubtitlesOptions": "NEVER_DOWNLOAD_SUBTITLES", "commentsPerPost": 0, … }
```

Three things are worth reading every time:

- **billable URLs** — the number of unique posts that will actually be charged.
  The example file has five lines and four billable posts, because the same
  `rides.withme` photo appears twice with different query strings. Duplicates
  are collapsed by TikTok **video id**, not by string equality.
- **charge cap** — the dollar ceiling, sent to Apify as `maxTotalChargeUsd` as
  well as enforced locally.
- **Actor input** — every paid add-on disabled explicitly. Actor defaults belong
  to the vendor and can change; a silently re-enabled video download is visible
  here _before_ it is paid for.

Field names are taken from the Actor's published input schema rather than
guessed, because Apify **ignores an unrecognised input field silently**. A
misspelled flag therefore looks disabled in the dry-run output while doing
nothing at all — the one failure mode here that costs money without ever raising
an error. Two spellings are worth knowing:

- subtitles are an enum, not a boolean: `downloadSubtitlesOptions` is set to
  `NEVER_DOWNLOAD_SUBTITLES`, and transcription is the neighbouring
  `DOWNLOAD_SUBTITLES_AND_TRANSCRIBE` value rather than a field of its own;
- `aiVideoDescription` and `aiVideoSummary` are charged **per video-second** on
  top of the per-result price. They default to `false`, which is precisely why
  they are set explicitly — these are the two options that would actually hurt.

If a future build renames a field, the dry-run output is where it shows up:
compare the printed input against the Actor's current input schema before
spending anything.

## 3. A paid run

Set the token in the shell only. Never on the command line (it would land in
your shell history), never in a file, never committed:

```powershell
$env:APIFY_TOKEN = 'paste-token-locally-here'
```

```bash
pnpm compare:tiktok-apify -- data/examples/tiktok-apify-smoke.txt --execute
```

Afterwards, clear it:

```powershell
Remove-Item Env:APIFY_TOKEN
```

The token is read from the environment, held in one private field, and sent only
as `Authorization: Bearer …`. It is never appended to a URL — which keeps it out
of Apify's request logs as well as ours — and every artifact passes through
recursive redaction on the way to disk. Request headers are never part of any
artifact payload at all.

### Options

| Flag                      | Default                     | Hard ceiling |
| ------------------------- | --------------------------- | ------------ |
| `--execute`               | off (dry run)               | —            |
| `--actor <id>`            | `clockworks/tiktok-scraper` | —            |
| `--max-charge-usd <usd>`  | `0.25`                      | `$5`         |
| `--max-urls <n>`          | `5`                         | `25`         |
| `--local-timeout-ms <ms>` | `15000`                     | —            |
| `--apify-timeout-ms <ms>` | `120000`                    | —            |
| `--output-dir <dir>`      | `./output/comparisons`      | —            |

The hard ceilings are in code and unreachable by any flag. `--max-charge-usd 250`
is one slipped keystroke from `2.50`, so it is refused rather than honoured.
`APIFY_ACTOR_ID` is also read from the environment when `--actor` is absent.

## 4. What it produces

`output/comparisons/<timestamp>/` (already gitignored):

| File                  | Contents                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| `input-manifest.json` | Normalized targets, every raw URL that collapsed onto each, and all parser issues                      |
| `local-results.jsonl` | Our own scrape, in the production `MetricSnapshot` format — it round-trips through `parseSnapshotLine` |
| `apify-dataset.json`  | The Actor's dataset exactly as received, apart from redaction                                          |
| `comparison.jsonl`    | One joined row per requested video                                                                     |
| `summary.json`        | Machine-readable findings, economics and caveats                                                       |
| `report.md`           | The human answer                                                                                       |

## 5. How the comparison is made

**Joined by video id, never by dataset order.** An Actor that retries,
parallelises or drops a URL returns rows in an order unrelated to the input, and
a positional join would silently attribute one video's metrics to another —
a failure that is invisible in the output. It is therefore impossible by
construction here.

**Neither source covers for the other.** If the local scrape is blocked and
Apify succeeds, the row records a local failure and an Apify success; the
metrics are not merged, and salvaged partial data from a failed scrape never
becomes a number in a delta. A missing value is `null`, never `0`, and two
`null`s are never counted as agreement.

**Each source keeps its own clock.** Separate observation timestamps and
latencies, so timing skew between the two readings stays visible.

### The granularity question

For each row the report classifies the two view counts:

- `resolution` — the finest power of ten that divides each value.
- `expectedStep` — the rounding _commonly observed_ on public TikTok pages: unit
  precision below 10,000; 100s from 10,000; 100,000s from 1,000,000.
- `apifyMoreGranular` — true only when Apify resolves finer **and** the two
  values are within one rounding step of each other. `1,200,000` vs `1,234,567`
  is extra precision; `1,200,000` vs `1,930,412` is a disagreement, and the
  report says so instead.

Those thresholds are a **diagnostic, not a contract**. TikTok has never
documented them, and trailing zeros alone prove nothing — a video can genuinely
have 1,200,000 views. Accordingly nothing in this tool ever calls a value
_exact_. The vocabulary is `quantized`, `rounded display value` and
`more granular`, and establishing exactness would need ground truth (creator
analytics) that this benchmark does not have. The report restates that limit in
its own caveats, along with any view band the sample failed to cover.

### Cost and bandwidth

Recorded only from what the API actually reported: `usageTotalUsd`,
`chargedEventCounts`, pricing model, build, run duration, `stats.netRxBytes` and
`stats.netTxBytes`. Anything absent is printed as `unavailable` and named in
`summary.economics.unavailable` — never inferred from the Actor's pricing page.
Cost per successful video divides actual spend by results that were actually
usable, and the 1K/10K/100K figures are labelled as linear projections.

Apify's bandwidth and ours are reported separately and must not be added up:
Apify's is traffic on Apify's servers, already inside the per-result price, while
ours is what our proxy provider would bill. Ours is measured by a benchmark-only
`CountingHttpClient` decorator — body plus header bytes, not true socket bytes,
since TLS framing and compression are invisible from the client. Production
transport is untouched; delete the decorator and the pipeline is unchanged.

## 6. The API surface it depends on

Every endpoint, query parameter and response field was checked against the
published API v2 documentation rather than assumed:

| Call             | Path                                                               |
| ---------------- | ------------------------------------------------------------------ |
| Start a run      | `POST /v2/actors/{owner~name}/runs`                                |
| Poll a run       | `GET /v2/actor-runs/{runId}`                                       |
| Read the dataset | `GET /v2/actor-runs/{runId}/dataset/items?format=json&clean=false` |

The documented run path is `/v2/actors/…`; `/v2/acts/…` is a legacy alias that
still resolves, and is deliberately not relied on.

Safety parameters on the start call: `maxTotalChargeUsd` (the cost ceiling Apify
itself enforces, in addition to the local cap), `maxItems`, `timeout` in seconds,
and `waitForFinish`. The API caps `waitForFinish` at 60 seconds and rejects
anything larger, so the client clamps it rather than trusting its caller — a
generous timeout should not become a failed run.

Run creation returns `201` with the run wrapped in `data`; the dataset endpoint
returns a bare JSON array. All eight documented statuses are handled explicitly:
`READY` and `RUNNING` keep polling, `SUCCEEDED` is the only success, and
`FAILED`, `TIMING-OUT`, `TIMED-OUT`, `ABORTING` and `ABORTED` are terminal
failures.

## 7. Testing a second Actor

`ActorAdapter` is the only seam that knows a vendor. Implement `buildInput`,
`describeFeatureFlags` and `normalizeRow`, and the join, delta, precision,
economics and report code needs no change. `ClockworksTikTokAdapter` reads the flat
output shape this Actor documents — `playCount` and friends at the top level,
the author under `authorMeta.name` / `.signature` / `.fans`, identity in `id`,
`webVideoUrl` and `submittedVideoUrl`. The nested (`stats.playCount`,
`author.uniqueId`) branch is a **defensive fallback** for a build that reverts to
TikTok's own payload naming, not a shape observed on this Actor; it is consulted
only when the flat field is absent, so it cannot mask the documented one.

Error rows are detected by `errorCode`, which is the Actor's documented
discriminator, not only by a message field. That distinction is load-bearing: a
failed row that carried a code but no recognised message would otherwise be read
as a _successful_ row whose metrics all happened to be null — inflating the
count of videos Apify handled and disguising a source failure as "Apify reported
nothing for this metric".

## 8. Tests

Every test is deterministic and makes no network call, paid or free
(`tests/benchmark/`, 149 tests). They cover the paid boundary without ever
crossing it: dry run issues zero requests, execute refuses without a token,
Bearer auth carries no leak, each terminal run status is handled, 401/402/429/5xx
behave as intended, malformed metrics stay `null`, and secrets are scrubbed from
artifacts on disk.

## 9. The local baseline, and what the smoke test will actually decide

Our own scraper was run against the four smoke URLs first. This costs nothing,
involves no Apify, and is worth doing before any paid run — if our half were
broken, the report would be four rows of "local failed" and the money would buy
nothing. Reproduce with `pnpm cli tiktok data/examples/tiktok-apify-smoke.txt`.

Measured 2026-08-19, 4/4 succeeded:

| Video                 |     Views |     Likes | Comments | Shares | Band | View resolution |
| --------------------- | --------: | --------: | -------: | -----: | ---- | --------------: |
| `7668862416435907873` |     1,554 |       359 |        5 |     13 | <10K |               1 |
| `7623071715257634068` |       760 |        43 |        1 |      0 | <10K |              10 |
| `7643585712641559841` | 3,000,000 |   696,646 |    1,540 | 33,375 | 1M+  |         100,000 |
| `7670640507646741793` | 8,900,000 | 1,709,320 |    4,849 | 46,690 | 1M+  |         100,000 |

The 1M+ pair is what makes the smoke test worth running. Both report views on a
clean 100,000 step while their likes, comments and shares on the very same post
are unit-precise — so the coarseness is specific to views, not a property of
these particular numbers. That is the local half of the question answered for
free; whether Apify resolves those two any finer is the half that costs $0.25.

Two predictions, written down before spending so the result cannot be
rationalised afterwards:

- if Apify also returns exactly 3,000,000 and 8,900,000, it is reading the same
  public rounded value and buys no view precision;
- if it returns something like 3,041,882, it carries lower-order detail we do
  not — still not proof of exactness, but grounds for a larger experiment.

### One field we lose, and why it is not an argument for Apify

Our scraper returns `saves` as `null` on all four. Everything else the embed page
can give — handle, follower count, `posted_at` — comes back fine, so `saves` is
the single gap.

It is worth being precise about the cause, because the obvious reading is wrong.
`TikTokScraper` fetches `/embed/v2/{id}`, whose payload has no `collectCount`
field, so `parseTikTokEmbedState` sets `saves: null`. The _other_ parser path in
the same file, for the full `webapp.video-detail` payload, already maps
`stats.collectCount` onto `saves` and has all along.

So this is a consequence of which endpoint we chose, **not** evidence that saves
are only obtainable from a paid provider. If Apify returns `collectCount` on the
smoke run, the honest conclusion is "TikTok exposes this and our current
acquisition path does not ask for it" — a reason to look at our own endpoint,
not a reason to buy the data. The report must not be read as "Apify gives us
saves that we cannot otherwise get."

Changing the production acquisition path is out of scope for this experiment and
nothing here does it.

## 10. After the smoke test

The four-URL set covers <10K and 1M+ but **not** the 10K–999,999 middle band,
and four posts is far too few to generalise from either way. A real answer needs
12–20 URLs spanning all three bands, across ordinary videos and photo posts.

**That run costs money and needs explicit approval before it is started.**
