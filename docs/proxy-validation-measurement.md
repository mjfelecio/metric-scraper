# What proxy validation should prove — the measurement behind #26

Issue [#26](https://github.com/mjfelecio/metric-scraper/issues/26) asked whether the
pre-admission TCP probe was worth keeping, and required the answer to be **measured**
rather than argued. This is that measurement, kept so the decision can be re-run instead
of re-litigated: `pnpm diagnose:proxy` reproduces the live half of it.

Everything below is labelled by how it was obtained — measured, observed in code, or
judgement — because the previous round of this decision generalised from a number nobody
had checked.

---

## 1. What the TCP probe proved

**Observed in code.** `TcpProxyProbe` was a bare `net.connect` with a 5 s socket timeout,
and `ProxySourceManager.admit` branched on `result.ok` alone — `reason` and `durationMs`
were computed and discarded. Admission therefore established exactly one fact: _something
accepted a TCP connection on that host and port within 5 s_. Nothing about HTTP CONNECT,
nothing about TLS, nothing about forwarding.

The layers a candidate must actually clear, and where the old probe stopped:

```
candidate → DNS/parse → TCP → CONNECT tunnel → TLS → HTTP round trip → target accepts
                         ^^^
                    admitted here
```

## 2. #26's two headline numbers were both artifacts

**Measured**, live ProxyScrape list (695 entries, 2026-08-19), TCP pass rate by position
in the list:

| Sample     | TCP pass |
| ---------- | -------- |
| head 20    | 90%      |
| head 100   | 68%      |
| tail 100   | 25%      |
| random 250 | 42%      |

The manager harvests FIFO from the head of the list, and the list is quality-ordered. #26
measured 30 passes / 2 failures — the first ~19 entries — and concluded the probe removes
~6% of candidates. Over a whole list it removes 58%. **The probe was never a no-op; it
just cannot discriminate among what it keeps.**

**Measured**, from the 20 run artifacts in `output/`, joining `proxies.per_proxy[].source`
with the evicted rows (`source: "unknown"` — tallies the metrics kept for proxies the pool
no longer lists; all have zero successes, since eviction requires it):

| Population                            | ever succeeded, of those that took ≥1 request |
| ------------------------------------- | --------------------------------------------- |
| source-admitted (TCP-probed)          | ~18–21%                                       |
| `config` (`PROXY_POOL`, never probed) | 60/307 = 19.5%                                |

So "~90% never succeed" is really ~80%, and — the part that matters — **hand-picked
config proxies do no better**. That figure is a property of the free-proxy population, not
evidence that the probe is worse than nothing. What it does establish is that the probe
adds no discrimination on top of the base rate.

## 3. What actually kills admitted proxies

**Measured**, 172 health-degradation events from `*.proxy-events.jsonl` in runs after #24
made the error `cause` chain survive:

| Category                                                                             | Share     | Visible to a TCP connect?   |
| ------------------------------------------------------------------------------------ | --------- | --------------------------- |
| connect timeout to the proxy                                                         | 33.1%     | yes — drift after admission |
| **CONNECT refused** (`Proxy response (400/403/405/500) !== 200 when HTTP Tunneling`) | **24.4%** | **no**                      |
| target rate limit                                                                    | 11.0%     | no — and must not be        |
| request timeout                                                                      | 11.0%     | no                          |
| **reset mid-flight**                                                                 | **9.9%**  | **no**                      |
| **TLS interception** (`SELF_SIGNED_CERT_IN_CHAIN`, `CERT_HAS_EXPIRED`)               | **5.8%**  | **no**                      |
| TCP refused                                                                          | 4.7%      | yes — drift                 |

**~40% of proxy-attributed failure is structurally invisible to a TCP connect and visible
to a CONNECT+TLS probe.** Another ~38% is drift — the proxy was fine at admission and died
later — which no pre-admission probe of any strength addresses.

_Caveat, observed in code and data:_ every `UND_ERR_CONNECT_TIMEOUT` in `output/` reads
`timeout: 10000ms`, undici's default, so all of these runs predate #25's connect-timeout
cap. The cap changes how long a connect-timeout failure costs, not how many there are.

## 4. The layered probe, measured

**Measured**, 250 candidates sampled at random from the same 695-entry list. Each got a
TCP connect, then a CONNECT tunnel to `www.gstatic.com:443`, then a TLS handshake, then
`GET /generate_204`:

| Layer                                       | Passed | of sample |
| ------------------------------------------- | ------ | --------- |
| TCP connect — _what the old probe admitted_ | 105    | 42.0%     |
| CONNECT tunnel established                  | 36     | 14.4%     |
| TLS validated + canary `204` — _usable_     | 25     | 10.0%     |

**P(usable │ TCP pass) = 25/105 = 23.8%.** Three quarters of every admission was
structurally waste. A second run through `pnpm diagnose:proxy` on a fresh 1098-entry list
put the same figure at 24.6%.

## 5. The decisive experiment: the budget has to match production

**Measured**, head-of-list 120 candidates, admitted by canary probe, then one real request
per platform through each admitted proxy:

| Probe                           | Admits         | TikTok 200 | Instagram 200 | either                     |
| ------------------------------- | -------------- | ---------- | ------------- | -------------------------- |
| TCP connect, 5 s                | ~68% of 120    | —          | —             | **~21%** (derived from §4) |
| Canary, connect 3 s / total 5 s | 26/120 (21.7%) | 54%        | 58%           | **65%**                    |
| Canary, connect 3 s / total 8 s | 34/120 (28.3%) | 47%        | 56%           | 62%                        |
| Canary, 12 s budget             | 27/120         | 30%        | 26%           | 33%                        |

Two things follow, and the implementation depends on both:

1. **Admission precision roughly triples**, ~21% → 65%.
2. **A probe more patient than production is worse than a strict one.** The looser budgets
   admit _more_ proxies and score _lower_: the extra admissions are the slow ones (4.7 s,
   5.9 s, 6.9 s canary latency) that undici then drops on its own `connectTimeout: 3000`.
   The probe must spend the same connect budget a real request will.

## 6. Is proxy validity target-specific?

**Measured.** Of 17 proxies that reached either platform, 12 reached both. The sets
largely coincide, so a single neutral canary predicts adequately for TikTok and Instagram
alike. **Judgement:** per-target validation would buy little, would couple the proxy layer
to platform specifics, and is ruled out by #26's zero-platform-traffic constraint anyway.

## 6b. End-to-end, after the change

**Measured**, two runs on 2026-08-19 with `PROXY_POOL` empty, so every proxy in the pool
had been admitted by the canary probe and nothing else:

| Run                    | URLs | success rate | `admission_to_first_success_rate` |
| ---------------------- | ---- | ------------ | --------------------------------- |
| `instagram-…T06-35-17` | 20   | **1.00**     | 0.29 (2/7 tried)                  |
| `instagram-…T06-38-15` | 20   | **1.00**     | **0.60** (3/5 tried)              |

Comparable archived Instagram runs on the TCP probe ranged 0.06–0.80, clustering near
0.4–0.5, with an admission-to-first-success rate around 0.20.

**Two runs of twenty URLs is suggestive, not proof** — n is small, it is one platform, and
free-proxy quality varies hour to hour. The claim these runs support is that the change
works end to end and moves the metric the right way, not that 100% is the new normal.

The stage counters behaved as designed in the field, and confirmed the design's premise:
across these runs `tunnel` was consistently the largest rejection bucket (12–13 of ~16
failures), i.e. **most free-list entries are not proxies at all** — a fact a TCP connect
cannot observe. A `response` bucket also registered non-zero in one run: proxies that
tunnel and handshake correctly and then return something other than the canary's own
status.

## 7. What was decided

- **"Usable" means:** within the production latency budget, the proxy accepts a CONNECT
  tunnel to an arbitrary TLS origin, forwards a handshake that validates against the
  public trust store, and returns the origin's own response unmodified.
- **Before admission:** exactly that, once, against `www.gstatic.com/generate_204`.
  CONNECT-only is not enough — TLS interception (4.4% measured live, 5.8% of production
  degradation) passes CONNECT cleanly.
- **After admission:** unchanged. 65% is not 100%, and the residual is drift and target
  policy, so the pool's probation/health/eviction model remains the only source of target
  trust. Real outcomes still decide everything about _using_ a proxy.
- **Not validated:** anonymity, geography, latency ranking beyond pass/fail, target
  reachability, or re-probing on refresh. No separate TCP prefilter either — the canary's
  own connect phase is that probe, on the correct budget.

**Judgement, not measurement:** the residual 35% is assumed to be drift plus target
policy. It has not been decomposed. If eviction churn does not fall after this change,
that decomposition is the next thing to measure — and the cause is more likely #22/#23
than the probe.

## 8. Cost

**Measured.** Admitted candidates cost p50 ≈ 1.7 s; rejected ones cost up to the 5 s
budget. Admission drops from ~68% to ~22% at the head of the list, so filling the same
capacity probes roughly three times as many candidates — about 30 s at concurrency 10,
absorbed by the existing bootstrap rounds. Supply is not a constraint: 22% of a
~700-entry list is ~150 usable proxies per refresh. Egress is one CONNECT, one handshake
and a `204` per candidate — a few KB, and zero bytes to any platform.

## 9. Found along the way

- **SOCKS candidates poison the pool.** `parseProxySourceText` and `parseProxyEntry`
  accept `socks4`/`socks5`; the old TCP probe passed them; `createProxyAgentFactory`
  then throws a plain `Error` from _outside_ `FetchHttpClient`'s try block, so it escapes
  `toHttpError`, is normalised to `unknown` → not retryable → `neutral`, and the proxy is
  never blamed, never cooled and never evicted. It burns one job per lease for the life of
  the process. The canary probe keeps them out of a dynamic pool, but the escaping-error
  path is a separate defect and is not fixed here.
- **`admitted` could never have answered #26's acceptance criterion.** It is a live gauge
  that drops when a proxy is evicted — and every evicted proxy is one that never
  succeeded. Deriving an admission-to-first-success rate from it would delete exactly the
  failures it is meant to count. Hence the cumulative `admitted_total` / `admitted_tried`
  / `admitted_proven` trio now in the run summary.
- **The rate is denominated in admissions the pool actually leased**, not in admissions.
  A short run that needed one of six proxies would otherwise report the probe as 17%
  accurate when it had been right every time — the metric would fall as the pool got
  healthier. `admitted_total` is still reported alongside so the gap stays visible.
