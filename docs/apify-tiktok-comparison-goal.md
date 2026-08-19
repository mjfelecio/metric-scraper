# Claude Code goal: compare Apify with the BloxClips TikTok scraper

Date prepared: 2026-08-19

## Before starting

The working branch is:

```text
research/apify-tiktok-comparison
```

It was created from the latest `origin/main`. Do not merge or copy work from
`fix/instagram-attempt-timeout`; that work is being reviewed separately in PR #37.

The first Apify actor to benchmark is `clockworks/tiktok-scraper`. Its current
documented direct-video input field is `postURLs`, and its output includes
`playCount`, `diggCount`, `commentCount`, `shareCount`, `collectCount`, creator
metadata, and the submitted/canonical video URL.

Useful official references:

- https://apify.com/clockworks/tiktok-scraper
- https://apify.com/clockworks/tiktok-scraper/input-schema
- https://docs.apify.com/api/v2
- https://docs.apify.com/api/v2/actors-runs-post
- https://docs.apify.com/api/v2/actor-run-dataset-items-get

Apify is paid and the account currently has only promotional credit. Never start
an Actor as part of a normal unit test, install hook, build, or dry run. A live
run must require an explicit flag and a small charge ceiling.

## Copy-paste `/goal` prompt

Paste the following into Claude Code after `/goal`:

```text
Implement a safe, research-only benchmark that compares the existing BloxClips
TikTok scraper with Apify's `clockworks/tiktok-scraper` using the same input URLs.

The main question is:

Does Apify provide more granular TikTok view counts than our scraper, or does it
return the same public rounded/quantized values?

This is a benchmark and decision tool, not a production Apify integration.

PHASE 1 — UNDERSTAND AND ADAPT TO THE CODEBASE

Before planning or editing, study the repository and build a correct mental model.
At minimum, read:

- README.md
- package.json and pnpm-lock.yaml
- specification.txt
- src/cli/index.ts and src/cli/execute-batch.ts
- src/app/composition.ts and src/app/run-service.ts
- src/core/models/snapshot.ts and src/core/models/scrape-result.ts
- src/core/scraper/http-port.ts and src/infrastructure/http/fetch-http-client.ts
- src/core/input/parse-input.ts and src/infrastructure/input/file-input-loader.ts
- src/platforms/tiktok/tiktok-scraper.ts
- src/platforms/tiktok/tiktok-hydration-parser.ts
- src/platforms/tiktok/tiktok-player-parser.ts
- src/platforms/tiktok/tiktok-url-normalizer.ts
- representative tests for the runner, HTTP client, input loader, and TikTok scraper
- recent git history so new filenames, naming, error handling, tests, and commit
  messages match established project style

Do not force a generic architecture onto this repository. Reuse its URL
normalization, schemas, error vocabulary, dependency injection, logging, and
test patterns where they fit. If this prompt suggests a filename or boundary
that conflicts with the current design, adapt it and explain why.

Confirm that the current branch is `research/apify-tiktok-comparison`, that it
started from `origin/main`, and that the worktree is clean before editing. Do not
bring PR #37's timeout commits into this branch.

PHASE 2 — PLAN BEFORE IMPLEMENTING

Write a concise implementation plan and inspect enough code to prove each step
fits the existing architecture. Then implement it fully without waiting for
approval unless a paid live run or a missing secret is the only remaining step.

NON-GOALS

- Do not add Apify as a production TikTok provider or fallback.
- Do not change the default TikTok scraper, web dashboard, payout logic, or
  MetricSnapshot contract merely for this experiment.
- Do not download videos, covers, avatars, music, subtitles, comments, or related
  videos.
- Do not add OAuth, browser cookies, TikTok sessions, or proxy credentials.
- Do not claim an Apify number is exact merely because it has more trailing digits.
- Do not expose, print, persist, or put `APIFY_TOKEN` in a URL.

IMPLEMENTATION REQUIREMENTS

1. Add a standalone TypeScript comparison command, preferably under `scripts/`,
   with a small package script if that matches repository conventions. A suitable
   interface is:

   pnpm run compare:tiktok-apify -- <input-file> [options]

2. Reuse the existing input loader and TikTok URL normalizer. Accept the same
   newline text and JSON-array inputs as the normal scraper. Reject non-TikTok
   URLs, normalize URL variants, and deduplicate by TikTok video ID so duplicate
   query-string forms are not billed twice.

3. Make these values configurable:

   - `APIFY_TOKEN` — required only for an executed Apify run
   - `APIFY_ACTOR_ID` — default `clockworks/tiktok-scraper`
   - maximum total charge in USD — safe default no higher than $0.25
   - maximum submitted URLs — default 5 and hard safety ceiling 25
   - local and Apify timeouts

   Keep the token out of config dumps, errors, logs, output files, command lines,
   and request URLs. Authenticate with `Authorization: Bearer <token>`.

4. Default to dry-run mode. Dry run must validate and normalize the input, show
   the exact number of billable candidate URLs, show the actor ID and charge cap,
   show the redacted Actor input, and make zero Apify requests.

5. A paid run must require an explicit option such as `--execute`. Refuse to run
   when the token is missing, the URL count exceeds the configured/hard cap, the
   charge cap is invalid, or the actor ID is malformed. Never quietly fall back
   from dry-run to paid mode.

6. For `clockworks/tiktok-scraper`, send the smallest direct-post input possible:

   - `postURLs`: normalized unique URLs
   - `scrapeRelatedVideos: false`
   - `scrapeAdditionalAuthorMeta: false`
   - every media/download option disabled
   - subtitles/transcription disabled
   - comments and replies set to zero where the actor accepts those fields
   - no hashtag, profile, or search queries

   Keep actor-specific input construction behind a narrow benchmark adapter so a
   second actor can be tested later without changing comparison logic. Validate
   output defensively because Actor schemas can change.

7. Use Apify API v2. Prefer the existing HTTP abstractions if they fit without
   coupling the production scraper to Apify; otherwise use an injected `fetch`
   boundary local to the benchmark. The expected flow is:

   - POST `/v2/acts/{actor-id-with-slash-replaced-by-tilde}/runs`
   - pass `waitForFinish` with a maximum of 60 seconds
   - pass `timeout`, `maxItems`, and `maxTotalChargeUsd` safety parameters
   - if still running, poll `/v2/actor-runs/{run-id}` with bounded backoff
   - accept only `SUCCEEDED` as success
   - retrieve `/v2/actor-runs/{run-id}/dataset/items?format=json&clean=false`

   Handle READY, RUNNING, SUCCEEDED, FAILED, TIMING-OUT, TIMED-OUT, ABORTING,
   and ABORTED explicitly. Apply a local overall deadline. Handle 401, 402/usage
   limits, 429, 5xx, invalid JSON, missing dataset rows, and actor error rows with
   clear redacted errors.

8. Run the current local TikTok collector and Apify as close together as practical.
   Preserve a separate observation timestamp and latency for each source. Do not
   silently substitute one source for the other when either fails.

9. Normalize Apify rows into a benchmark-only shape containing, when available:

   - video ID and canonical/submitted URL
   - views/playCount
   - likes/diggCount
   - comments/commentCount
   - shares/shareCount
   - saves/collectCount
   - author handle and public bio/signature
   - observation time
   - source status/error

   Support both nested and flat output forms only when fixtures prove the mapping.
   Do not turn malformed or missing numeric fields into zero.

10. Join the two sources by normalized TikTok video ID, never by result order.
    Produce one comparison row per requested unique video with:

    - both raw metric sets
    - absolute and signed deltas for each comparable metric
    - same-value booleans
    - local and Apify latency
    - each source's success/failure state
    - whether Apify's view count contains lower-order detail that the local public
      value does not

    Use the observed public-view precision only as a diagnostic:

    - below 10,000: usually unit precision
    - 10,000 through 999,999: commonly 100-view increments
    - 1,000,000 and above: commonly 100,000-view increments

    Call this `quantized`, `rounded display value`, or `more granular`; never call
    it exact without independent ground truth. TikTok has not documented these
    thresholds as a stable contract, and trailing zeros alone are not proof.

11. Write timestamped research artifacts under the already-ignored `output/`
    tree, for example `output/comparisons/<timestamp>/`:

    - normalized input manifest
    - local raw JSONL/results
    - raw Apify dataset response
    - joined comparison JSON or JSONL
    - machine-readable summary JSON
    - short human-readable Markdown report

    Redact secrets recursively before writing. Never persist request headers.
    Include Actor ID, run ID, terminal status, Actor build/version identifiers,
    observation times, URL counts, and the input feature flags so the experiment
    can be reproduced.

12. Record actual economics and bandwidth only when the API supplies them:

    - `usageTotalUsd`
    - `chargedEventCounts`
    - pricing model/build information
    - run duration
    - `stats.netRxBytes` and `stats.netTxBytes`
    - local response bytes measured through a benchmark-only HTTP decorator if
      this can be done without changing production behavior

    Calculate actual cost per successful result and projections for 1,000,
    10,000, and 100,000 videos from the completed run. Label projections clearly.
    If cost or bandwidth is missing, output `null`/`unavailable`; do not invent it
    from marketing copy. Distinguish Apify's server bandwidth from the bandwidth
    our own proxy provider would bill.

13. The human report must answer:

    - Did Apify return the same rounded view values?
    - Did it return more granular views for any 10K+ or 1M+ sample?
    - Are likes, comments, shares, saves, handle, and bio more complete?
    - What failed for either source?
    - What was actual run cost and cost per successful video?
    - What bandwidth was observed per video and projected at expected volume?
    - Is there evidence to justify another experiment or production integration?

    If the sample is too small or there is no ground truth, say so explicitly.

TEST REQUIREMENTS

All normal tests must be deterministic and make no internet or paid calls. Add
fixtures and injected fakes to cover at least:

- dry run performs zero Apify requests
- missing token in execute mode
- actor ID conversion and validation
- Bearer authentication without token leakage
- minimal Actor input with all paid add-ons disabled
- URL normalization, query variants, and video-ID deduplication
- URL cap and charge-cap refusal
- immediate successful run
- polling from RUNNING to SUCCEEDED
- every terminal failure status
- 401, 429 with bounded retry, and 5xx behavior
- local overall timeout
- dataset error rows and missing requested rows
- flat and nested Apify metric fixtures
- null/malformed metrics are not converted to zero
- joining by video ID when result order differs
- delta calculations and more-granular/quantized classification at threshold edges
- cost, bandwidth, and volume projections
- recursive secret redaction
- output/report generation

Run and report:

- formatting check for changed files
- lint
- TypeScript typecheck
- the new focused tests
- the complete test suite
- server and web production builds

LIVE SMOKE TEST

Do not run a paid live test unless `APIFY_TOKEN` is already present and the user
explicitly authorizes `--execute`. Unit and mocked integration tests are required
regardless.

For the first authorized live smoke test, use at most these four unique IDs and a
maximum charge of $0.25:

- https://www.tiktok.com/@emrys8473/video/7643585712641559841
- https://www.tiktok.com/@emrys8473/video/7668862416435907873
- https://www.tiktok.com/@lyndon.films/video/7670640507646741793
- https://www.tiktok.com/@rides.withme/photo/7623071715257634068

The two rides.withme URL variants previously supplied point to the same post and
must be billed once. After the smoke test, build a better 12–20 URL benchmark set
covering below 10K, 10K–999,999, 1M+, ordinary videos, and photo posts. Get user
approval before that larger paid run.

DELIVERY AND COMMITS

- Keep production behavior unchanged.
- Do not commit generated output or secrets.
- Add clear usage documentation with dry-run and execute examples.
- Make small commits following the repository's existing style, for example:
  1. `feat(benchmark): add Apify TikTok comparison harness`
  2. `test(benchmark): cover Apify comparison flow`
  3. `docs(benchmark): explain the paid comparison workflow`
- Before declaring completion, inspect the final diff and prove each acceptance
  requirement with code or test evidence.
- Finish with the exact command Sage should run for the paid smoke test, but do
  not include the token in that command or in the response.

SUCCESS CRITERIA

- A safe dry run works with no token and no network charge.
- A paid run cannot start accidentally and has both URL and dollar ceilings.
- Local and Apify results are joined correctly by TikTok video ID.
- The report distinguishes exactness, granularity, rounding, and source failure.
- Actual cost/bandwidth metadata is retained when provided and never guessed.
- Tests cover the paid boundary without performing paid calls.
- Existing production scraping remains unchanged and the full validation suite
  passes.
```

## Sage's manual setup for the eventual live test

Do not paste the token into chat or commit it. In the terminal session that will
run the benchmark, set it only as an environment variable:

```powershell
$env:APIFY_TOKEN = 'paste-token-locally-here'
```

First run the benchmark without `--execute` and inspect the URL count, Actor ID,
disabled add-ons, and charge cap. Only then run the explicit paid command produced
by the completed implementation.

After testing, remove the token from the current terminal environment:

```powershell
Remove-Item Env:APIFY_TOKEN
```
