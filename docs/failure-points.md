# Failure points

A living registry of behavior the [stress-testing harness](stress-testing.md) has actually
caught — one entry per distinct failure mode, kept even after it's addressed, so "we found
this, here's why, here's what we did about it" survives past the conversation that found
it. This is not a list of harness limitations (those live in
[`stress-testing.md` §11](stress-testing.md#11-known-limitations)); it's a list of things a
**run** surfaced about the scraper's behavior under load.

Every entry answers the same four questions, in order: what did we see, why does it
happen, is it a real problem or a configuration choice, and what should someone do about
it. Findings from the mocked harness describe **infrastructure** behavior (concurrency,
proxy rotation, retry/cooldown dynamics) — they say nothing about how real TikTok/Instagram
respond at volume, which only the real acceptance run can show. Say so explicitly in any
new entry that could be misread as a platform-behavior claim.

## Adding an entry

Copy this template, assign the next `FP-NNN` id, and fill in every field. Cite exact
numbers from the run's `.report.json` and, where useful, the raw `.jsonl` rows — a claim
without a number next to it is a guess, not a finding.

```markdown
## FP-NNN: <short, specific title>

- **Discovered:** YYYY-MM-DD, via `<exact command>`
- **Classification:** `bug` | `misconfiguration` | `capacity limitation` | `expected behavior`
- **Severity:** `blocking` | `degraded` | `informational`
- **Status:** `open` | `mitigated` | `resolved` (link the commit once it is)

**What we saw** — the observable symptom, in the report's own numbers.

**Root cause** — the causal chain, traced to specific config values/code paths.

**Is this a bug or a misconfiguration?** — the direct answer, stated plainly.

**Recommended action** — what to actually change, and what re-running afterward should show.

**Evidence** — artifact paths (`.report.json` / `.jsonl`) and exact reproduction command.
```

## Index

| ID                                                                                   | Title                                                              | Classification      | Status |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------- | ------ |
| [FP-001](#fp-001-proxy-pool-cascades-into-full-exhaustion-at-500rpm-with-10-proxies) | Proxy pool cascades into full exhaustion at 500rpm with 10 proxies | capacity limitation | open   |

---

## FP-001: Proxy pool cascades into full exhaustion at 500rpm with 10 proxies

- **Discovered:** 2026-08-21, via `pnpm stress-test --profile acceptance --platform tiktok`
  (default `normal` workload; `.env`'s `SCRAPER_CONCURRENCY=10`, `PROXY_POOL` with 10
  entries, `PROXY_MAX_FAILURES=3`, `PROXY_COOLDOWN_MS=60000`, `PROXY_MAX_CONCURRENT=8`,
  `PROXY_ACQUIRE_WAIT_MS=5000`, `RETRY_MAX_ATTEMPTS=3` — all defaults, none overridden for
  this run)
- **Classification:** `capacity limitation` (not a scraper logic bug)
- **Severity:** `blocking` — fails the acceptance profile's own pass/fail gate outright
- **Status:** `open`

### What we saw

A full 10-minute, 500 rpm run against the mocked TikTok upstream (4,999 requests over
600.15s — essentially the spec's exact volume and duration) came back `FAIL` with:

| Metric                                    | Value                 | Spec bar |
| ----------------------------------------- | --------------------- | -------- |
| Success rate                              | 62.5% (3,125/4,999)   | ≥95%     |
| Longest window sustained at ≥500rpm       | 9.6s                  | 600s     |
| Retries                                   | 4,060 (81.2% of jobs) | —        |
| Proxies cooling by run end                | 10/10                 | —        |
| Pool-exhaustion events (`pool_exhausted`) | 5,713                 | —        |
| Peak queue depth                          | 116                   | —        |

The row-level error breakdown is the tell: of 1,874 failed jobs, **1,837 (98%) failed with
`proxy_error`** — the job never got a proxy lease at all. Only 37 failures came from the
mock's own scripted content scenarios (`timeout: 33`, `blocked: 2`, `http_error: 2`).

### Root cause

This is a proxy-capacity cascade, not a content-failure problem:

1. The workload's ~5% scripted first-attempt failure rate causes proxies to intermittently
   accumulate consecutive failures.
2. `PROXY_MAX_FAILURES=3` benches a proxy after 3 in a row; `PROXY_COOLDOWN_MS=60000` keeps
   it out for a full minute.
3. With only 10 proxies, once a few are benched, survivors absorb more concurrent load
   (the 500rpm admission rate doesn't slow down for them) — which raises _their_ odds of
   also hitting 3-in-a-row.
4. This is self-reinforcing: fewer usable proxies → more load per proxy → more benching →
   fewer usable proxies. `unhealthy_since` timestamps across all 10 proxies show this
   repeating in bursts throughout the run, not as a single one-time event — by the end, all
   10 were simultaneously cooling.
5. Once the whole pool is out, every new job waits up to `PROXY_ACQUIRE_WAIT_MS=5000`, then
   fails with a retryable `proxy_error` — burning a retry attempt without ever reaching the
   (mocked) platform. That is the 81% retry rate and the 1,837 `proxy_error` failures.

A secondary, concrete contributor found while tracing this: of the 221 failures actually
_attributed to a specific proxy_ (as opposed to pool-wide exhaustion), **`timeout` accounts
for 85 (38%)** despite being only ~1% of the scripted workload's weight — a ~19x
disproportionate share. Cause: retryable HTTP-status scenarios (403/429/500) were fixed to
recover on retry (a fresh proxy lease shouldn't repeat someone else's rate-limit), but
`embed_timeout`/`player_timeout` were left permanent-per-id, so an unlucky id burns _three
separate proxies_ (one per attempt, all guaranteed to fail) instead of one. Being addressed
in a follow-up commit — see the Status line once it lands.

### Is this a bug or a misconfiguration?

**A misconfiguration relative to the target rate** — `10 proxies × PROXY_MAX_FAILURES=3 ×
PROXY_COOLDOWN_MS=60000` was never sized for 500 sustained rpm. The scraper's own logic
(earned capacity, rotation, cooldown, retry) is behaving exactly as designed; the pool it
was handed is too small and too punishing for this volume. The timeout-scenario gap noted
above is a real harness-fidelity bug (it makes the mock overstate cascade risk from that
one scenario type specifically), but it is not the primary driver — pool exhaustion would
still dominate even with it fixed, since 98% of failures never touched a scripted scenario
at all.

### Recommended action

Before spending real TikTok/Instagram traffic on the actual acceptance run:

1. **Widen `PROXY_POOL`.** More proxies directly lowers per-proxy load and the odds of a
   pool-wide simultaneous cooldown.
2. **Reconsider `PROXY_MAX_FAILURES`/`PROXY_COOLDOWN_MS`.** A higher failure tolerance
   and/or a shorter cooldown reduces how long a benched proxy stays unusable, shrinking the
   window in which the remaining pool is overloaded.
3. **Re-run `pnpm stress-test --profile acceptance --platform tiktok`** (and `instagram`,
   `mixed`) against the adjusted config and confirm `PASS` — specifically, watch
   `pool_exhausted` trend toward 0 and `proxies.cooling` stay well under `configured` for
   the whole run, not just the final snapshot.
4. Only then run the real, unmocked acceptance benchmark
   (`pnpm cli tiktok data/acceptance/tiktok-valid-100.txt --watch --interval 0 --duration
10m --target-rpm 500 --concurrency 25`, per [`stress-testing.md` §9](stress-testing.md#9-relationship-to-the-real-acceptance-benchmark)).

### Evidence

- `output/stress-acceptance-2026-08-21T07-20-32-331Z.report.json`
- `output/stress-2026-08-21T07-20-32-333Z.jsonl`
- Reproduction: `pnpm stress-test --profile acceptance --platform tiktok`
