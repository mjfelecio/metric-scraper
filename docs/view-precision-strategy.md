# TikTok view precision: hybrid scraper + Apify fallback

Design notes for work not yet started. Nothing in `src/` implements this today.

Written after the August 2026 benchmark in
[apify-tiktok-comparison.md](apify-tiktok-comparison.md), which measured our
scraper against two Apify Actors on the same posts. Read that first for the
evidence; this document is only the plan that follows from it.

## 1. The problem, in one table

Our scraper is exact on everything except views:

| Metric                  | Source                                                  | Rounded? |
| ----------------------- | ------------------------------------------------------- | -------- |
| views                   | `/embed/v2/` → `itemInfos.playCount`                    | **yes**  |
| likes, comments, shares | `/player/api/v1/items` → `statistics_info.*`            | no       |
| saves                   | not collected — the embed payload has no `collectCount` | —        |

The split is not about metric quality. Endpoints that render a page hand back a
display value; endpoints that feed a client hand back the raw counter. Views
are the one number we take from a rendering endpoint, because
`/player/api/v1/items` returns no play count at all.

Measured rounding, from the benchmark:

| Real views (novi) | What we report |   Error |
| ----------------: | -------------: | ------: |
|         2,984,398 |      3,000,000 | +15,602 |
|         9,097,645 |      9,100,000 |  +2,355 |
|             1,562 |          1,562 |       0 |
|               760 |            760 |       0 |

TikTok's observed steps: unit below 10K, 100 from 10K, 100,000 from 1M. Below
1M the worst case is ±50 views. At 1M it is **±50,000**.

> These bands are behaviour observed across a handful of posts, not a
> documented TikTok contract. They can change without notice. Any code relying
> on them should be easy to retune.

## 2. The rule: route on a threshold, not on trailing zeros

```
views >= 1_000_000  →  ask novi
views <  1_000_000  →  keep ours
```

**Do not detect rounding by looking for trailing zeros.** Between 10K and 999K
TikTok rounds to the nearest 100, so nearly every clip in that band ends in
`00` and would look rounded. That test fires on almost the entire catalogue and
turns a targeted fallback into a bill for everything, while buying precision
worth at most 50 views.

The threshold is deterministic, has no false positives, and targets the only
band where the error is material.

## 3. The failure rule, and why it matters more than the routing

**If the Apify call fails, write nothing. Keep the last stored value and retry
next cycle.**

The tempting alternative — fall back to our own scraper's number — creates a
phantom decrease:

```
day 1   novi ok      →  stored 1,343,535
day 2   novi fails   →  ours says 1,300,000   ← views appear to drop 43,535
```

Views cannot decrease. That drop is harmful in two specific ways here:

1. **It looks like botting.** A sudden view drop is exactly the signal used to
   flag inflated clips, so the fallback would manufacture clawback candidates
   against honest clippers.
2. **It corrupts delta-based payouts.** A period measured as −43,535 views is
   not a number any payout formula should ever see.

A stale value is harmless. A value that moved backwards is not. When in doubt,
do not write.

### If a write is ever unavoidable

Treat a rounded reading as a **range, not a point**. `1,300,000` at the
100,000 step means "somewhere in 1,250,000–1,349,999". A stored 1,343,535
falls inside that range, so nothing decreased — keep what you have.

Only when the stored value sits outside the range the new reading allows is
there a genuine decrease worth recording or flagging.

### Provenance is required, not optional

Every stored view value needs to carry where it came from and how precise it
is — at minimum `source` (`local` / `apify`) and the rounding step that applied.

Once a value is marked exact, a rounded value must never overwrite it. Without
that field the range check above cannot be implemented, and neither can
"compare only like with like" in any payout or fraud rule downstream.

## 4. Cost model

`novi/tiktok-scraper-ultimate` is pay-per-event. Submitting individual video
URLs fires two charged events, not one:

| Event                | Trigger               | FREE tier |    GOLD+ |
| -------------------- | --------------------- | --------: | -------: |
| `result-item`        | each video returned   |  $0.00030 | $0.00028 |
| `single-video-query` | each direct video URL |  $0.00300 | $0.00060 |
| `start`              | once per run          |  $0.00020 | $0.00010 |

So **the advertised $0.28/1,000 is not the price for this use case.** That rate
covers `result-item` alone, which is what you pay scraping by profile or
hashtag. Looking up a specific video also charges `single-video-query`, ten
times more than the result itself. Real cost on the FREE tier is **$0.0033 per
video**, verified against a live run:

```
result-item        4 × $0.0003 = $0.0012
single-video-query 4 × $0.0030 = $0.0120
start              1 × $0.0002 = $0.0002
                                 -------
                                 $0.0134   (matches the billed run exactly)
```

Two consequences for implementation:

- **Batch aggressively.** `start` is charged per run, so one run of 500 URLs
  costs $0.0000004/video in start fees and 500 runs of one URL cost $0.0002
  each. Never issue one run per video.
- **The threshold is the budget.** Routing only 1M+ clips keeps this at roughly
  $15–50/month at plausible volumes. Routing everything multiplies it by ~30.

Also note: the Actor refuses to start with `maxTotalChargeUsd` below **$2.00**
(clockworks refuses below $0.50). The ceiling is not a charge, but it cannot be
set to a token amount.

## 5. Rejected: switching wholesale to an Actor

`clockworks/tiktok-scraper` is the popular option (240k monthly users) and is
**worse than what we have**. It reads the same web payload we do, so its views
carry identical rounding, and it additionally rounds likes and shares:

|        |      ours | clockworks |      novi |
| ------ | --------: | ---------: | --------: |
| likes  | 1,734,595 |  1,700,000 | 1,734,575 |
| shares |    47,363 |     47,400 |    47,363 |

Adopting it would have degraded three metrics to fix none. Recorded here so the
question is not reopened from the star count.

## 6. Open questions before building

- **No ground truth.** novi returns _unrounded_ views; nothing yet proves they
  are _correct_. Check a handful of clips against a creator's own TikTok
  analytics on an account we control — free, and the only thing that settles it.
- **Build vs. buy.** novi's advantage is that it reads TikTok's mobile `aweme`
  API rather than the web one. That is an endpoint, not a moat — but reaching it
  requires app-style request signing that TikTok rotates specifically to break
  unofficial clients. Buying is paying for maintained access, not for data.
- **Sample size.** The benchmark covered 4 posts, two of them 1M+. The
  10K–999K band is untested. A 12–20 URL set spanning all three bands would say
  how often this actually bites.
- **Volume.** Monthly clip count and re-check frequency are the two inputs that
  turn the cost model above into a real number.
