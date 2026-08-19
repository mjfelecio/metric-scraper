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

## 6. Testing a second Actor

`ActorAdapter` is the only seam that knows a vendor. Implement `buildInput`,
`describeFeatureFlags` and `normalizeRow`, and the join, delta, precision,
economics and report code needs no change. `ClockworksTikTokAdapter` reads both
the flat (`playCount`) and nested (`stats.playCount`) output shapes, each proven
by a fixture — support is added when a fixture proves the mapping, not when the
docs suggest it.

## 7. Tests

Every test is deterministic and makes no network call, paid or free
(`tests/benchmark/`, 149 tests). They cover the paid boundary without ever
crossing it: dry run issues zero requests, execute refuses without a token,
Bearer auth carries no leak, each terminal run status is handled, 401/402/429/5xx
behave as intended, malformed metrics stay `null`, and secrets are scrubbed from
artifacts on disk.

## 8. After the smoke test

The four-URL set is a smoke test — too small to generalise from, and it contains
no 1M+ post, the band where public rounding is coarsest and where a paid source
would have to earn its keep. A real answer needs 12–20 URLs spanning below 10K,
10K–999,999 and 1M+, across ordinary videos and photo posts.

**That run costs money and needs explicit approval before it is started.**
