# Acquisition and operations note guide

This guide supports the specification deliverable:

> A short written note describing the endpoints and methods used, observed rate limits and
> blocking, estimated proxy bandwidth per 1,000 requests, and the parts most likely to break
> when either platform changes.

Use this document as both a checklist while gathering evidence and a template for the final
submission note. Keep the final note short; link to run summaries and screenshots instead of
copying every statistic into it.

## 1. Evidence rules

Label every statement as one of the following:

- **Implemented:** demonstrated by the current code and deterministic tests.
- **Observed directly:** measured in a saved live-run artifact. Name the artifact and date.
- **Observed through a proxy:** measured using a real configured proxy provider. Name the
  provider mode, but never expose its credentials.
- **Unverified:** supported by the code but not yet demonstrated in the required live
  environment.

Do not describe a direct-IP run as a proxy measurement. Do not turn an isolated smoke run
into a sustained-throughput claim. A run reaching 500 RPM for twelve seconds does not prove
that it can hold 500 RPM for ten minutes.

Before citing a run, confirm:

- `totals.requests` is the number of logical URL jobs;
- `totals.platform_http_requests` is the number of first-party platform calls;
- `bandwidth.requests` is the number of measured HTTP round trips;
- `throughput.requests_per_minute` counts logical jobs, not retries;
- `proxies.mode` identifies `static` or `rotating-residential` on current summaries;
- the output JSONL contains exactly `output.rows_written` rows;
- secrets are absent from the summary, logs, JSONL, screenshots, and shell history.

## 2. Endpoint and method inventory

### TikTok

| Order                        | Method and endpoint                                                                 | Purpose                                                                               | Important behavior                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1                            | `GET https://www.tiktok.com/embed/v2/{video_id}`                                    | Public post hydration: views, identity, author details, and posting time when present | Large view counts can be rounded by TikTok at the source                      |
| 2                            | `GET https://www.tiktok.com/player/api/v1/items?item_ids={video_id}&language=en-US` | Replaces embed likes, comments, and shares with precise integer counters              | Does not provide an exact large view count or saves                           |
| Before scraping, when needed | `GET` a supported `vm.tiktok.com` or `vt.tiktok.com` URL                            | Resolve a short link to a canonical `/@handle/video/{id}` or `/photo/{id}` URL        | At most five TikTok-owned redirects; uses the same proxy and timeout controls |

TikTok is anonymous and first-party. The scraper accepts video and photo post URLs. It does
not guess missing values: unavailable saves remain `null`, and a malformed or changed payload
becomes a visible `parse_error` row.

### Instagram

| Order                          | Method and endpoint                                         | Purpose                                                                                                         | Important behavior                                                                                       |
| ------------------------------ | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1                              | `GET https://www.instagram.com/`                            | Bootstrap an anonymous CSRF cookie, cached per proxy                                                            | HTTP success without a CSRF token is a retryable `blocked` result, and the failed cache entry is removed |
| 2                              | `POST https://www.instagram.com/graphql/query`              | Post metadata operation: media identity, likes, comments, author/coauthors, media type, and views when supplied | Uses configurable `INSTAGRAM_POST_DOC_ID`                                                                |
| 3, only when views are missing | `POST https://www.instagram.com/graphql/query`              | Creator/coauthor clips operation used to locate an exact Reel play count                                        | Uses configurable `INSTAGRAM_CLIPS_DOC_ID`, bounded pages/authors, and a run-scoped cache                |
| Authenticated fallback         | `GET https://i.instagram.com/api/v1/media/{media_id}/info/` | Recover exact media information when anonymous acquisition cannot provide views                                 | Requires a valid Instagram session bound to the same proxy lease                                         |
| Before scraping, when needed   | `GET` a supported Instagram `/share/` or `instagr.am` URL   | Resolve it to a canonical `/reel/`, `/p/`, or `/tv/` URL                                                        | At most five Instagram-owned redirects                                                                   |

Instagram normally takes about two or three HTTP requests for a recent Reel. Older,
coauthored, paginated, or authenticated-fallback cases can take more. Exact view acquisition
is required for an `ok` result; shares and saves stay `null` when Instagram does not expose
them publicly.

An explicit empty post `items` array means that Instagram returned no publicly available
media. It is recorded as non-retryable `not_found` after the existing authenticated fallback
has had a chance to recover it. That observation cannot distinguish deletion from privacy,
restriction, region limitation, or another form of anonymous unavailability.

### Deleted, private, and publicly unavailable posts

Neither platform exposes a reliable, universal field proving that a creator deleted a post.
The collectors can only classify the response that the platform returned at scrape time:

| Platform  | Observed signal                                    | Raw scraper status | What the signal proves                                     |
| --------- | -------------------------------------------------- | ------------------ | ---------------------------------------------------------- |
| TikTok    | HTTP 404                                           | `not_found`        | The requested post was not found through that public path  |
| TikTok    | HTTP 400 from the public embed path                | `private`          | The post is not publicly readable or is creator-only       |
| Instagram | HTTP 404                                           | `not_found`        | The requested post was not found through that public path  |
| Instagram | Redirect to login                                  | `private`          | Anonymous access is not allowed                            |
| Instagram | Valid post response with an explicit empty `items` | `not_found`        | Instagram returned no publicly available media anonymously |

An absent post may have been deleted, made private, restricted, moderated, region-limited, or
made unavailable for another reason. These cases can produce indistinguishable public
responses, so the scraper must not claim a more specific reason than it observed.

For the BloxClips product, map both raw `not_found` and `private` outcomes to the user-facing
category **private/unavailable video**. This category includes deleted posts when deletion
cannot be proven. Keep the raw status and error message in stored JSONL and internal reviews
so engineering can still distinguish the platform signal, avoid unnecessary retries, and
audit classification changes. Do not rewrite historical observations or replace either
status with a fabricated `deleted` result.

## 3. Rate-limit and blocking evidence

### What the implementation recognizes

| Signal                                             | Recorded result                             | Retry/proxy behavior                                                           |
| -------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------ |
| HTTP 429                                           | `status: rate_limited`, code `rate_limited` | Retryable; proxy outcome is `blocked`                                          |
| HTTP 403 or a recognized verification/WAF response | `status: rate_limited`, code `blocked`      | Retryable; proxy outcome is `blocked`                                          |
| Instagram bootstrap returns no CSRF token          | `status: rate_limited`, code `blocked`      | Retryable; bootstrap is not permanently cached                                 |
| HTTP 451                                           | `status: error`, code `geo_blocked`         | Retryable on another proxy; static exit can be retired after repeated failures |
| Transport/timeout/5xx failure                      | Typed error row                             | Retry according to the configured attempt budget                               |
| Valid `not_found` or `private` response            | Permanent URL outcome                       | No unnecessary retry; does not punish the proxy                                |
| Invalid JSON or changed schema                     | `parse_error`                               | Non-retryable and neutral to proxy health                                      |

Two different rate controls must be reported separately:

- `SCRAPER_TARGET_RPM` limits logical URL jobs admitted per minute.
- `SCRAPER_HTTP_RPM_PER_HOST` limits actual platform HTTP calls per host, including retries
  and multi-request Instagram jobs.

### What to write from a live run

For each platform, record:

1. Input size, duration, target RPM, configured concurrency, and proxy mode.
2. Logical RPM and `sustained_target_ms` from the session summary.
3. Logical successes and success rate.
4. Raw platform HTTP calls and calls per logical job.
5. Counts of `rate_limited`, `blocked`, `geo_blocked`, timeout, and network errors.
6. Retry totals and exhausted jobs.
7. Proxy pool/gateway failures, blocks, retirements, and exhaustion.
8. Whether the run recovered after blocks or only finished before cooldowns expired.

Use language like this:

> In the saved `[platform/run-id]` residential run, `[N]` logical jobs produced `[H]`
> first-party HTTP calls. We observed `[X]` HTTP 429/rate-limit outcomes, `[Y]` blocked/WAF
> outcomes, and `[Z]` transport failures. `[R]` jobs were retried and `[E]` exhausted their
> attempt budget. The run held `[RPM]` logical RPM for `[duration]`.

If a number is zero, say **none observed in this run**, not **the platform has no rate limit**.

## 4. Bandwidth per 1,000 requests

Enable measurement with `METRICS_BANDWIDTH=true` (the current default). The summary reports:

```text
bandwidth.request_bytes
bandwidth.response_bytes
bandwidth.total_bytes
bandwidth.requests
bandwidth.bytes_per_request
```

Use `bandwidth.requests` as the denominator for **1,000 actual HTTP requests**:

```text
bytes per 1,000 HTTP requests = bandwidth.bytes_per_request * 1,000
decimal MB                     = result / 1,000,000
MiB                            = result / 1,048,576
```

For **1,000 logical scrape jobs**, account for platform fan-out:

```text
bytes per 1,000 logical jobs = bandwidth.total_bytes / totals.requests * 1,000
HTTP calls per logical job   = totals.platform_http_requests / totals.requests
```

Always state which denominator is being used. “Requests” is ambiguous because one TikTok
job normally makes two platform requests and one Instagram job can make several.

### Existing direct baselines

These are useful calculation examples, not final proxy-provider evidence:

| Artifact                                                                                        | Result                               | Per 1,000 HTTP calls | Per 1,000 logical jobs |
| ----------------------------------------------------------------------------------------------- | ------------------------------------ | -------------------: | ---------------------: |
| `output/tiktok-2026-08-21T02-07-19-154Z.summary.json`                                           | 100 jobs, 206 calls, 5,841,788 bytes |             28.36 MB |               58.42 MB |
| `output/acceptance-instagram-valid-10-final-2/instagram-2026-08-21T01-57-13-493Z.summary.json`  | 10 jobs, 22 calls, 370,996 bytes     |             16.86 MB |               37.10 MB |
| `output/acceptance-instagram-source-validation/instagram-2026-08-21T01-48-10-224Z.summary.json` | 100 jobs, 140 calls, 2,111,905 bytes |             15.09 MB |               21.12 MB |

The 100-job Instagram run had only 72% success and predates the unavailable-media
classification correction, so it must not be presented as the final Instagram acceptance
baseline. The 10-job run succeeded 10/10 but is a small smoke sample.

The measurement counts HTTP request bytes plus compressed response bytes at the transport
dispatcher, before decompression. It does not include TLS framing, the proxy CONNECT
handshake, proxy-provider accounting overhead, proxy-list discovery, or acceptance evidence
such as screenshots. Therefore describe it as an estimate until it has been compared with
the provider's own usage dashboard.

### Optional cost calculation

After recording the provider's actual price per GB:

```text
estimated cost per 1,000 = bytes per 1,000 / 1,000,000,000 * price per GB
```

State whether the provider bills decimal GB or GiB and whether failed requests are billed.

## 5. Known fragility

### TikTok

- The embed hydration JSON and player endpoint are undocumented and may change shape or
  disappear.
- TikTok can change its challenge/WAF markers or return HTTP 200 with unusable content.
- Large view counts from the public embed source can be rounded. The player response fixes
  likes, comments, and shares but not views or saves.
- Mobile/API-based unrounded views are research only; they are not implemented in the
  production collector.
- Short-link redirect rules or allowed hostnames may change.

### Instagram

- GraphQL document IDs and response shapes are undocumented and can change. IDs are
  configurable so they can be replaced without editing parser logic.
- Creator/coauthor clips lookup is deliberately bounded. Difficult old posts may require an
  authenticated fallback.
- Sessions can expire, be challenged, or become invalid, and must remain bound to their
  matching proxy.
- Public responses often do not expose shares and saves.
- An anonymous empty-media response cannot identify whether the post is deleted, private,
  restricted, region-limited, or unavailable for another reason.

### Proxy and scale layer

- Rotating-residential mode is implemented but has not yet been validated against a paid
  live gateway.
- Static and residential modes have different concurrency ceilings, so their throughput
  cannot be compared fairly unless effective capacity is aligned.
- Proxy health is process-local; multiple workers would need shared rate limits, health,
  leases, and job coordination.
- Sticky residential sessions are provider-specific and are not implemented.
- A ten-minute, 500-logical-RPM live run remains required for each platform.

## 6. Evidence-gathering workflow

### Before the run

1. Record the Git commit with `git rev-parse HEAD`.
2. Confirm the working tree with `git status --short --branch`.
3. Copy the acceptance dataset into the evidence folder or record its checksum.
4. Record non-secret configuration: platform, proxy mode, target RPM, concurrency, attempt
   limits, HTTP rate cap, request timeout, and platform attempt timeout.
5. Verify that no credential appears in the command line or run configuration.

### Smoke test

```powershell
pnpm cli tiktok data/acceptance/tiktok-valid-10.txt --concurrency 1 --target-rpm 10 --max-attempts 1 --json
pnpm cli instagram data/acceptance/instagram-valid-10.txt --concurrency 1 --target-rpm 10 --max-attempts 1 --json
```

Check the JSONL and summary before spending ten minutes on a broken configuration.

### Acceptance session

Use enough input repetitions or cycles to produce at least 5,000 logical jobs:

```powershell
pnpm cli tiktok data/acceptance/tiktok-valid-100.txt --watch --interval 0 --duration 10m --target-rpm 500 --concurrency <measured-value> --json
pnpm cli instagram data/acceptance/instagram-valid-100.txt --watch --interval 0 --duration 10m --target-rpm 500 --concurrency <measured-value> --json
```

Choose concurrency from measured latency:

```text
required concurrency ~= (target RPM / 60) * mean latency in seconds
```

Do not silently increase timeouts or relax the 95% success requirement merely to make the
run pass. Preserve failed rows and explain their classifications.

### After the run

1. Save the session summary, all cycle summaries, JSONL, proxy events, and redacted logs.
2. Export the proxy provider's bandwidth/traffic report for the same time window.
3. Compare measured scraper bytes with provider-billed bytes.
4. Capture ten randomly selected live metric comparisons per platform.
5. Record unexplained discrepancies and rerun only after stating what changed.
6. Keep tokens, cookies, proxy usernames/passwords, and session files outside Git.

## 7. Final short-note template

Copy this section into a separate final evidence note after the acceptance runs. Replace
every bracketed value; do not leave placeholders in the submitted version.

```markdown
# Metrics acquisition and operating observations

Evidence was collected from commit `[commit]` using `[proxy mode/provider]`. TikTok was
tested on `[date]`; Instagram was tested on `[date]`. The complete JSONL, session summaries,
cycle summaries, proxy events, and manual comparison evidence are stored under `[path]`.

## Endpoints and methods

TikTok uses anonymous first-party requests. It reads post hydration from
`GET /embed/v2/{video_id}` and then reads precise likes, comments, and shares from
`GET /player/api/v1/items`. Large public view counts can remain rounded because the player
response does not expose an exact play count.

Instagram first obtains an anonymous CSRF context with `GET /`, then calls
`POST /graphql/query` for post metadata and, when necessary, bounded creator/coauthor clips
pages. If exact views remain unavailable, a compatible proxy-bound session can call
`GET i.instagram.com/api/v1/media/{media_id}/info/`.

## Rate limits and blocking

The TikTok session processed `[N]` logical jobs and `[H]` platform HTTP calls over
`[duration]`, sustaining `[RPM]` logical RPM for `[sustained duration]`. It completed `[S]%`
successfully and observed `[429 count]` rate limits, `[blocked count]` blocks,
`[geo count]` geo-blocks, and `[transport count]` transport failures.

The Instagram session processed `[N]` logical jobs and `[H]` platform HTTP calls over
`[duration]`, sustaining `[RPM]` logical RPM for `[sustained duration]`. It completed `[S]%`
successfully and observed `[429 count]` rate limits, `[blocked count]` blocks,
`[geo count]` geo-blocks, `[session count]` session failures, and `[transport count]`
transport failures.

Retryable blocks use exponential backoff and a fresh proxy lease. Permanent `not_found`,
`private`, invalid-URL, and parser/schema failures are not retried unnecessarily.

## Bandwidth

TikTok measured `[bytes]` bytes across `[HTTP calls]` first-party HTTP calls, or `[MB] MB`
per 1,000 HTTP calls and `[MB] MB` per 1,000 logical jobs. Instagram measured `[bytes]`
bytes across `[HTTP calls]` calls, or `[MB] MB` per 1,000 HTTP calls and `[MB] MB` per
1,000 logical jobs. The provider reported `[provider bytes]` for the same windows. The
difference is `[difference/explanation]`.

## Known fragility

Both collectors depend on undocumented first-party response shapes. TikTok's embed payload
can change and still does not provide unrounded large views. Instagram's GraphQL document
IDs, clips response shape, and authenticated session behavior can change. Sessions can burn,
and proxy effectiveness depends on provider exit quality and geographic consistency. These
failures remain visible in JSONL and summaries rather than being replaced with zeroes or
silently dropped. Neither platform reliably distinguishes a deleted post from every other
form of public unavailability. BloxClips displays raw `not_found` and `private` outcomes as
**private/unavailable video** while retaining the original status for internal evidence.
```

## 8. Completion checklist

- [ ] Real proxy provider configured and credentials kept outside Git
- [ ] TikTok 500 logical RPM held for at least ten minutes
- [ ] Instagram 500 logical RPM held for at least ten minutes
- [ ] At least 5,000 logical jobs completed per platform
- [ ] At least 95% success on valid live URLs per platform
- [ ] Platform HTTP calls and retries reported separately from logical jobs
- [ ] Provider blocking and recovery observations recorded
- [ ] Scraper and provider bandwidth compared for the same time window
- [ ] Bandwidth shown per 1,000 HTTP calls and per 1,000 logical jobs
- [ ] Ten manual accuracy comparisons and screenshots saved per platform
- [ ] Twenty URLs scraped three times, producing 60 distinct timestamped rows
- [ ] Authenticated Instagram fallback tested with a dedicated account
- [ ] Known limitations and ambiguous classifications stated plainly
- [ ] No credentials, cookies, tokens, or sessions included in evidence
