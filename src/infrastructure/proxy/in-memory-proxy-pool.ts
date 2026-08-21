import { createHash } from 'node:crypto';

import { type Logger, nullLogger } from '../../core/logging/logger.js';
import { ScrapeError, type ScrapeErrorCode } from '../../core/models/errors.js';
import { type ProxyLease, type ProxyTarget } from '../../core/scraper/lease-ports.js';
import {
  type ProxyBlockKind,
  type ProxyEvent,
  type ProxyEventListener,
  type ProxyEviction,
  type ProxyHealth,
  type ProxyPool,
  type ProxyPoolStats,
  type ProxyState,
} from '../../core/scraper/pool-ports.js';
import {
  CONFIG_SOURCE,
  type ProxyRoster,
  type ProxySourceStats,
} from '../../core/scraper/proxy-source-ports.js';

import { proxyId, redactEntry } from './proxy-config.js';

/** Reasons are for reading, not for parsing; a stack-length message helps nobody. */
const MAX_REASON_LENGTH = 200;

/**
 * One lease in this many is reserved for a proxy that has never succeeded.
 *
 * The tension is deliberate: exploration spends requests on proxies likely to
 * fail. A fixed share is predictable and easy to bound, which is why it is this
 * rather than weighted-random selection — and 5 puts the cost at 20% of leases
 * in the worst case, while the failure threshold bounds what any one bad proxy
 * can waste.
 */
const DEFAULT_EXPLORATION_PERIOD = 5;

/**
 * How long `acquire` will wait for capacity to come back before failing.
 *
 * Sized against the thing that actually restores it: a candidate source
 * replenishes on a 2 s tick and validates with a 5 s probe timeout, so a few
 * seconds covers a tick and the admission that follows it. Long enough to turn
 * a burst of evictions into latency; short enough that a pool with nothing left
 * to give still fails the attempt rather than stalling the run.
 */
const DEFAULT_ACQUIRE_WAIT_MS = 5_000;

/**
 * Normalised loads closer than this count as equal, so LRU decides.
 *
 * `inFlight / capacity` is a ratio of small integers, but it is still floating
 * point, and an exact `!==` would let representation noise pick a proxy.
 */
const LOAD_EPSILON = 1e-9;

/** Cancels a pending timer. Returned by `setTimer` so callers cannot leak one. */
type CancelTimer = () => void;

export interface InMemoryProxyPoolOptions {
  targets: readonly ProxyTarget[];
  /** Consecutive failures before a proxy is put in cooldown. */
  maxConsecutiveFailures?: number | undefined;
  /** How long a failed or blocked proxy stays out of rotation. */
  cooldownMs?: number | undefined;
  /**
   * The most jobs any one proxy may hold at a time. `0` means unlimited.
   *
   * This is a ceiling, not an allocation: a proxy earns its way up to it (see
   * `capacityOf`). `proxies × limit` is therefore the pool's *maximum* capacity,
   * and `ProxyPoolStats.capacity` reports what has actually been earned.
   */
  maxConcurrentPerProxy?: number | undefined;
  /**
   * The floor every proxy starts at and can be pushed back down to. Defaults to 1.
   *
   * Health is evaluated at acquire time, so without a floor a proxy can be
   * handed to N jobs before the first of them reports anything — which is how a
   * dead IP absorbed 30 requests inside a 45 s run despite a 3-failure
   * threshold. A proxy that has never succeeded never leaves this floor, which
   * bounds its exposure to roughly `maxConsecutiveFailures` requests.
   */
  probationConcurrency?: number | undefined;
  /**
   * One lease in this many is reserved for a proxy that has never succeeded.
   * `0` disables exploration entirely. Defaults to 5.
   *
   * Without it, a proxy needs a success to be preferred but is scheduled last,
   * so it never gets the traffic that would earn one — and an 800-proxy pool
   * behaves like the two-proxy pool that happened to succeed first.
   */
  explorationPeriod?: number | undefined;
  /**
   * Refuse to hand out a direct connection, even with an empty roster.
   *
   * An empty roster normally means "no proxies configured, go direct", which is
   * the default for local development. That reading is wrong for a pool a
   * dynamic source fills: there, empty means the roster has been evicted down to
   * nothing, and answering `null` would put the origin IP on the wire at exactly
   * the moment the pool is least healthy. Set whenever a source is attached.
   */
  requireProxy?: boolean | undefined;
  /**
   * How long `acquire` waits for capacity to come back before failing.
   *
   * `0` fails at once, which is what the pool did before a dynamic source could
   * restore capacity within seconds. Waiting is bounded by this *and* by the
   * caller's abort signal, and only happens while recovery is actually
   * plausible — see `acquire`.
   */
  acquireWaitMs?: number | undefined;
  /**
   * Schedules a callback, returning its own canceller. Defaults to `setTimeout`.
   *
   * Injected for the same reason `now` is: a test that has to wait out a real
   * timer to observe the waiting path is a slow test that reports flakes as
   * failures.
   */
  setTimer?: ((fn: () => void, ms: number) => CancelTimer) | undefined;
  /**
   * Notified on every health transition, so a run can keep a record of when a
   * proxy went bad and when it came back. Never called for `healthy ⇄
   * saturated`, which is capacity rather than health.
   *
   * Called synchronously; a listener that throws would corrupt rotation, so
   * anything doing I/O must swallow its own errors.
   */
  onEvent?: ProxyEventListener | undefined;
  logger?: Logger | undefined;
  now?: (() => number) | undefined;
}

interface ProxyEntry {
  readonly id: string;
  /** `p1`…`pN`, in admission order. Short enough to scan a table by. */
  readonly label: string;
  /** `config`, or the name of the source that supplied it. */
  readonly source: string;
  /** Epoch ms it joined the roster. */
  readonly admittedAt: number;
  readonly target: ProxyTarget;
  requests: number;
  successes: number;
  failures: number;
  /** Failures blamed on the exit node itself rather than on the request. */
  unsuitable: number;
  consecutiveFailures: number;
  /** Consecutive unsuitable outcomes; a success clears it. Drives retirement. */
  consecutiveUnsuitable: number;
  blocked: boolean;
  /** Retired for good. A jurisdiction block does not expire like a cooldown. */
  retired: boolean;
  cooldownUntil: number | null;
  /** Why it is out of rotation. Cleared as soon as it is usable again. */
  blockKind: ProxyBlockKind | null;
  /** Jobs currently holding a lease on this proxy. */
  inFlight: number;
  /**
   * Concurrent slots this proxy has earned, before the configured ceiling.
   *
   * Doubles on a success and halves on any non-success, floored at
   * `probationConcurrency`. Kept as state rather than derived from the counters
   * because what matters is the *order* outcomes arrived in: 8 successes then 2
   * failures and 2 failures then 8 successes are the same totals and very
   * different proxies.
   */
  trustedSlots: number;
  /** Wall-clock time of the last lease. Reported; not used for ordering. */
  lastUsedAt: number | null;
  firstUsedAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  /** When it entered its current out-of-rotation state; `null` while usable. */
  unhealthySince: number | null;
  lastReason: string | null;
  lastErrorCode: ScrapeErrorCode | null;
  /**
   * Monotonic checkout order, used for least-recently-used rotation.
   *
   * A wall clock cannot order this: `Date.now()` has millisecond resolution and
   * many leases are taken within one millisecond once requests run
   * concurrently. Ties would then always resolve to the same proxy.
   */
  lastUsedSeq: number;
  /** Advances when one checkout generation supplies a health observation. */
  generation: number;
}

/**
 * Single-process proxy rotation with health tracking.
 *
 * Rotation is two-tiered. Proxies that have succeeded at least once are chosen
 * by *normalised* load — `inFlight / capacity`, so traffic fills proxies in
 * proportion to what they have earned — then least-recently-used. One lease in
 * `explorationPeriod` is reserved for a proxy that has never succeeded,
 * cheapest-first by request count. The reserved share is what stops the pool
 * collapsing onto whichever two proxies happened to work first: without it a
 * proxy needs a success to be preferred but is scheduled last, so it can never
 * earn one, and adding proxies adds no capacity at all.
 *
 * Health has three levels, because the three ways a proxy goes wrong need
 * different answers:
 *
 * - transient failure  → cooldown after `maxConsecutiveFailures`, then back
 * - detected block     → `markBlocked`, out until the cooldown expires
 * - unsuitable exit    → retired permanently after `maxConsecutiveFailures`,
 *                        since no amount of waiting moves an IP to another
 *                        jurisdiction
 *
 * Capacity is earned rather than switched on. Every proxy starts at
 * `probationConcurrency`, doubles its slots on each success up to
 * `maxConcurrentPerProxy`, and halves them on each non-success. That keeps the
 * bound that matters — a proxy that has never worked is still handed exactly
 * one job at a time, because health is only checked when a lease goes out —
 * without letting a single failure erase a proxy's whole record, which is what
 * made pool capacity equal to the number of usable proxies rather than to
 * `proxies × limit`. Waiting for a slot is bounded by the caller's abort
 * signal, never indefinite.
 *
 * Everything an operator needs to read the pool back — the state each proxy is
 * in, when it went bad, why, and when it is due back — is derived from these
 * same fields and published through `getStats`, so an observability view can
 * never disagree with what rotation actually did.
 */
export class InMemoryProxyPool implements ProxyPool, ProxyRoster {
  /** Mutable: a dynamic source adds and evicts entries while the pool runs. */
  private entries: ProxyEntry[] = [];
  /** Lookup by lease id. A linear scan ran on every report and every release. */
  private readonly byId = new Map<string, ProxyEntry>();
  private readonly maxConsecutiveFailures: number;
  private readonly cooldownMs: number;
  private readonly maxConcurrentPerProxy: number;
  private readonly probationConcurrency: number;
  private readonly explorationPeriod: number;
  private readonly requireProxy: boolean;
  private readonly acquireWaitMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => CancelTimer;
  private readonly onEvent: ProxyEventListener | null;
  private readonly logger: Logger;
  private readonly now: () => number;
  /** Resolved on every release, so waiters re-check for a free slot. */
  private waiters: (() => void)[] = [];
  /** Monotonic checkout counter backing LRU rotation. */
  private sequence = 0;
  /**
   * Monotonic label counter.
   *
   * Not an index into `entries`: with a dynamic roster, indices are reused as
   * proxies come and go, and a label that silently changes meaning is worse
   * than no label at all.
   */
  private labelSequence = 0;
  /**
   * Leases granted to established proxies since the last exploration.
   *
   * Only advanced when an established proxy was actually available, so the
   * warm-up — where nothing has succeeded yet and every lease necessarily goes
   * to an unproven proxy — does not bank a burst of exploration to spend the
   * moment the first proxy succeeds.
   */
  private exploreCredit = 0;
  private poolExhaustedCount = 0;
  private sourceStatsProvider: (() => ProxySourceStats) | null = null;
  private readonly evicted = new Map<string, ProxyEviction>();

  constructor(options: InMemoryProxyPoolOptions) {
    this.now = options.now ?? (() => Date.now());
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 3;
    this.cooldownMs = options.cooldownMs ?? 60_000;
    this.maxConcurrentPerProxy = options.maxConcurrentPerProxy ?? 0;
    this.probationConcurrency = Math.max(1, options.probationConcurrency ?? 1);
    this.explorationPeriod = Math.max(0, options.explorationPeriod ?? DEFAULT_EXPLORATION_PERIOD);
    this.requireProxy = options.requireProxy ?? false;
    this.acquireWaitMs = Math.max(0, options.acquireWaitMs ?? DEFAULT_ACQUIRE_WAIT_MS);
    this.setTimer = options.setTimer ?? defaultSetTimer;
    this.onEvent = options.onEvent ?? null;
    this.logger = options.logger ?? nullLogger;
    this.add(options.targets, CONFIG_SOURCE);
  }

  /**
   * Adds entries the pool does not already hold, returning how many were new.
   *
   * Ids it already holds are skipped rather than replaced: a source that lists
   * the same proxy on every refresh must not be able to reset that proxy's
   * health simply by naming it again, which is the whole point of tracking
   * identity across refreshes.
   */
  add(targets: readonly ProxyTarget[], source: string = CONFIG_SOURCE): number {
    const now = this.now();
    let added = 0;

    for (const target of targets) {
      const id = this.identify(target);
      if (id === null) continue;

      const entry: ProxyEntry = {
        id,
        label: `p${++this.labelSequence}`,
        source,
        admittedAt: now,
        target,
        requests: 0,
        successes: 0,
        failures: 0,
        unsuitable: 0,
        consecutiveFailures: 0,
        consecutiveUnsuitable: 0,
        blocked: false,
        retired: false,
        cooldownUntil: null,
        blockKind: null,
        inFlight: 0,
        trustedSlots: this.probationConcurrency,
        lastUsedAt: null,
        firstUsedAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        unhealthySince: null,
        lastReason: null,
        lastErrorCode: null,
        lastUsedSeq: 0,
        generation: 0,
      };
      this.entries.push(entry);
      this.byId.set(id, entry);
      added += 1;
    }

    // New capacity is only useful to jobs already blocked on a full pool.
    if (added > 0) this.wakeWaiters();
    return added;
  }

  /**
   * Removes an entry from rotation for good.
   *
   * Refuses while leases are outstanding: those jobs still hold the target and
   * will report an outcome against it, and dropping the entry underneath them
   * would silently discard that outcome.
   */
  evict(id: string): boolean {
    const entry = this.byId.get(id);
    if (entry === undefined || entry.inFlight > 0) return false;

    const now = this.now();
    const snapshot = this.healthSnapshot(entry, now);
    this.evicted.set(id, {
      ...snapshot,
      state: snapshot.state === 'saturated' ? this.healthOf(entry, now) : snapshot.state,
      inUse: false,
      inFlight: 0,
      evictedAt: now,
      evictionCount: 1,
    });
    this.byId.delete(id);
    this.entries = this.entries.filter((candidate) => candidate !== entry);
    return true;
  }

  setSourceStatsProvider(provider: (() => ProxySourceStats) | null): void {
    this.sourceStatsProvider = provider;
  }

  /**
   * The id this target would take, or `null` if the pool already holds it.
   *
   * `proxyId` is credential-free, so two entries on one gateway host — the
   * ordinary shape of a rotating residential pool, where the username carries
   * the session — would otherwise collapse onto a single id and have their
   * health merged. A short digest of the full URL separates them without
   * putting any part of the credential in the id.
   */
  private identify(target: ProxyTarget): string | null {
    const base = proxyId(target);
    const existing = this.byId.get(base);
    if (existing === undefined) return base;
    if (existing.target.url === target.url) return null;

    const suffixed = `${base}#${fingerprint(target.url)}`;
    if (this.byId.has(suffixed)) return null;
    this.logger.warn(
      { proxy_id: base },
      'multiple proxy entries share one host:port; ids are suffixed so their health stays separate',
    );
    return suffixed;
  }

  get size(): number {
    return this.entries.length;
  }

  /**
   * Leases a proxy, waiting for one only while waiting can actually help.
   *
   * The three ways there is nothing to hand out need three different answers,
   * and collapsing them is what turned a burst of evictions into a whole-run
   * outage:
   *
   * - **nothing configured** — go direct, unless `requireProxy` says this pool
   *   is fed by a source and an empty roster means "evicted to nothing" rather
   *   than "none wanted". Answering `null` there would put the origin IP on the
   *   wire at the worst possible moment.
   * - **temporarily out** — a cooldown expires inside the wait budget, or a
   *   source still holds candidates it could admit. Recovery is seconds away,
   *   so the attempt waits and costs latency instead of failing a job.
   * - **nothing left** — every proxy retired, no supply behind them. No amount
   *   of waiting produces a proxy, so this fails immediately, exactly as before.
   *
   * Silently falling back to a direct connection is never one of the answers.
   * Waiting is bounded by `acquireWaitMs` and by the caller's signal, and the
   * error raised when the budget runs out is the same retryable one as before,
   * so the retry policy's backoff still absorbs a genuinely benched pool.
   */
  async acquire(signal?: AbortSignal): Promise<ProxyLease | null> {
    const deadline = this.now() + this.acquireWaitMs;

    for (;;) {
      if (signal?.aborted === true) {
        throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
      }

      const now = this.now();
      // Expired cooldowns are noticed here rather than by a timer, so a proxy
      // coming back is recorded at the first moment it could matter.
      this.refresh(now);

      if (this.entries.length === 0 && !this.requireProxy) return null;

      const healthy = this.entries.filter((entry) => this.isUsable(entry, now));
      const free = healthy.filter((entry) => this.hasCapacity(entry));
      if (free.length > 0) {
        const chosen = this.select(free);
        chosen.inFlight += 1;
        chosen.lastUsedAt = now;
        chosen.firstUsedAt ??= now;
        chosen.lastUsedSeq = ++this.sequence;
        chosen.requests += 1;
        return { id: chosen.id, generation: chosen.generation, target: chosen.target };
      }

      if (healthy.length > 0) {
        // Usable proxies exist but all are at their concurrency limit. A lease
        // is outstanding and will come back, so this wait needs no deadline
        // beyond the caller's own.
        await this.waitForCapacity(signal, null);
        continue;
      }

      const budget = deadline - now;
      const recoverAt = this.earliestEligibleAt(now);
      const waitForCooldown = recoverAt !== null && recoverAt - now <= budget;
      const waitForSupply = this.supplyPending();

      if (budget <= 0 || (!waitForCooldown && !waitForSupply)) {
        this.poolExhaustedCount += 1;
        throw new ScrapeError({
          code: 'proxy_error',
          message:
            this.entries.length === 0
              ? 'the proxy pool is empty and its source has no candidates left to admit'
              : `all ${this.entries.length} configured proxies are blocked or cooling down`,
          retryable: true,
        });
      }

      // Wake for whichever comes first: a cooldown we decided to sit out, or
      // the end of the budget. An admission or a release wakes us sooner.
      await this.waitForCapacity(
        signal,
        waitForCooldown ? Math.min(budget, recoverAt - now) : budget,
      );
    }
  }

  /**
   * When the first benched proxy is due back, or `null` if none ever is.
   *
   * Retired proxies are skipped: a jurisdiction block does not expire, so they
   * are the difference between "wait, this comes back" and "nothing here will".
   */
  private earliestEligibleAt(now: number): number | null {
    let earliest: number | null = null;
    for (const entry of this.entries) {
      if (entry.retired || entry.cooldownUntil === null || entry.cooldownUntil <= now) continue;
      if (earliest === null || entry.cooldownUntil < earliest) earliest = entry.cooldownUntil;
    }
    return earliest;
  }

  /**
   * Whether a source could still admit a proxy this pool does not have yet.
   *
   * Read from the source's own published counters rather than from a second
   * copy of them: the manager already publishes `candidates` and `validating`
   * through `setSourceStatsProvider`, and those are exactly the states that mean
   * "more capacity may arrive shortly".
   */
  private supplyPending(): boolean {
    const stats = this.sourceStatsProvider?.();
    if (stats === undefined || stats === null) return false;
    return stats.candidates > 0 || stats.validating > 0;
  }

  release(lease: ProxyLease): void {
    const entry = this.byId.get(lease.id);
    if (entry !== undefined && entry.inFlight > 0) {
      entry.inFlight -= 1;
    }
    this.wakeWaiters();
  }

  reportSuccess(lease: ProxyLease): void {
    const entry = this.byId.get(lease.id);
    if (entry === undefined) return;

    this.transition(entry, () => {
      const now = this.now();
      entry.successes += 1;
      entry.lastSuccessAt = now;
      if (lease.generation !== entry.generation) return;
      entry.consecutiveFailures = 0;
      entry.consecutiveUnsuitable = 0;
      // Credited even for a straggler reporting in during a cooldown: the
      // request did work, and unlike clearing the cooldown below, trusting the
      // proxy with another slot cannot let it back into rotation early.
      this.earnTrust(entry);

      // A straggler must not un-bench a proxy. Health is only evaluated when a
      // lease is handed out, so jobs leased *before* the bench are still in
      // flight; letting one of them clear `cooldownUntil` on the way out meant
      // a 60 s cooldown was served for a few hundred milliseconds, and a
      // detected block was cancelled outright. The success is still recorded —
      // it just does not shorten the sentence.
      if (!this.isUsable(entry, now)) return;

      entry.cooldownUntil = null;
      // A success is the end of whatever was wrong, so the diagnosis goes with
      // it: leaving the old reason behind makes a healthy proxy read as sick.
      entry.blockKind = null;
      entry.unhealthySince = null;
      entry.lastReason = null;
      entry.lastErrorCode = null;
    });
  }

  reportFailure(lease: ProxyLease, reason?: string, errorCode?: ScrapeErrorCode): void {
    const entry = this.byId.get(lease.id);
    if (entry === undefined) return;

    this.transition(
      entry,
      () => {
        entry.failures += 1;
        entry.lastFailureAt = this.now();
        if (lease.generation !== entry.generation) return;
        entry.generation += 1;
        entry.consecutiveFailures = Math.min(
          this.maxConsecutiveFailures,
          entry.consecutiveFailures + 1,
        );
        this.loseTrust(entry);
        this.recordReason(entry, reason, errorCode);

        if (entry.consecutiveFailures >= this.maxConsecutiveFailures) {
          entry.cooldownUntil = this.now() + this.cooldownMs;
          entry.blockKind = 'consecutive_failures';
          this.logger.warn(
            { proxy_id: entry.id, failures: entry.consecutiveFailures, reason: reason ?? null },
            'proxy entered cooldown after consecutive failures',
          );
        }
      },
      reason,
      errorCode,
    );
  }

  reportUnsuitable(lease: ProxyLease, reason?: string, errorCode?: ScrapeErrorCode): void {
    const entry = this.byId.get(lease.id);
    if (entry === undefined) return;

    this.transition(
      entry,
      () => {
        entry.failures += 1;
        entry.unsuitable += 1;
        entry.lastFailureAt = this.now();
        if (lease.generation !== entry.generation) return;
        entry.generation += 1;
        entry.consecutiveUnsuitable = Math.min(
          this.maxConsecutiveFailures,
          entry.consecutiveUnsuitable + 1,
        );
        this.loseTrust(entry);
        this.recordReason(entry, reason, errorCode);

        // One 451 may just be a restricted URL. Several in a row with nothing
        // working in between is the exit node's jurisdiction, which no cooldown
        // will change — so the proxy goes for good rather than returning in 60 s
        // to burn the same share of every batch.
        if (entry.consecutiveUnsuitable >= this.maxConsecutiveFailures) {
          entry.retired = true;
          entry.blocked = true;
          entry.blockKind = 'unsuitable_exit';
          this.logger.warn(
            { proxy_id: entry.id, unsuitable: entry.consecutiveUnsuitable, reason: reason ?? null },
            'proxy retired: exit node is unsuitable for this target',
          );
        }
      },
      reason,
      errorCode,
    );
  }

  markBlocked(lease: ProxyLease, reason?: string, errorCode?: ScrapeErrorCode): void {
    const entry = this.byId.get(lease.id);
    if (entry === undefined) return;

    this.transition(
      entry,
      () => {
        entry.failures += 1;
        entry.lastFailureAt = this.now();
        if (lease.generation !== entry.generation) return;
        entry.generation += 1;
        entry.consecutiveFailures = Math.min(
          this.maxConsecutiveFailures,
          entry.consecutiveFailures + 1,
        );
        entry.blocked = true;
        entry.cooldownUntil = this.now() + this.cooldownMs;
        entry.blockKind = 'detected_block';
        this.loseTrust(entry);
        this.recordReason(entry, reason, errorCode);
        this.logger.warn({ proxy_id: entry.id, reason: reason ?? null }, 'proxy marked blocked');
      },
      reason,
      errorCode,
    );
  }

  getStats(): ProxyPoolStats {
    const now = this.now();
    this.refresh(now);

    const perProxy: ProxyHealth[] = this.entries.map((entry) => this.healthSnapshot(entry, now));
    const usable = perProxy.filter(
      (proxy) => proxy.state !== 'retired' && proxy.state !== 'cooling',
    );

    return {
      configured: this.entries.length,
      available: usable.length,
      inUse: perProxy.filter((proxy) => proxy.inFlight > 0).length,
      blocked: perProxy.filter((proxy) => proxy.blocked).length,
      retired: perProxy.filter((proxy) => proxy.retired).length,
      untested: perProxy.filter((proxy) => proxy.state === 'untested').length,
      cooling: perProxy.filter((proxy) => proxy.state === 'cooling').length,
      saturated: perProxy.filter((proxy) => proxy.state === 'saturated').length,
      totalInFlight: perProxy.reduce((total, proxy) => total + proxy.inFlight, 0),
      // Only usable proxies count: capacity is what the pool can serve *now*,
      // which is the number to compare a configured concurrency against.
      capacity:
        this.maxConcurrentPerProxy <= 0
          ? null
          : usable.reduce((total, proxy) => total + (proxy.capacity ?? 0), 0),
      poolExhaustedCount: this.poolExhaustedCount,
      totalRequests:
        perProxy.reduce((total, proxy) => total + proxy.requests, 0) +
        [...this.evicted.values()].reduce((total, proxy) => total + proxy.requests, 0),
      totalFailures:
        perProxy.reduce((total, proxy) => total + proxy.failures, 0) +
        [...this.evicted.values()].reduce((total, proxy) => total + proxy.failures, 0),
      source: this.sourceStatsProvider?.() ?? null,
      evicted: [...this.evicted.values()],
      evictionCount: this.evicted.size,
      perProxy,
    };
  }

  private healthSnapshot(entry: ProxyEntry, now: number): ProxyHealth {
    return {
      id: entry.id,
      label: entry.label,
      source: entry.source,
      admittedAt: entry.admittedAt,
      state: this.stateOf(entry, now),
      blockKind: entry.blockKind,
      requests: entry.requests,
      successes: entry.successes,
      failures: entry.failures,
      unsuitable: entry.unsuitable,
      consecutiveFailures: entry.consecutiveFailures,
      consecutiveUnsuitable: entry.consecutiveUnsuitable,
      blocked: entry.blocked,
      retired: entry.retired,
      cooldownUntil: entry.cooldownUntil,
      eligibleAt: entry.retired ? null : this.isUsable(entry, now) ? null : entry.cooldownUntil,
      inUse: entry.inFlight > 0,
      inFlight: entry.inFlight,
      capacity: finiteOrNull(this.capacityOf(entry)),
      firstUsedAt: entry.firstUsedAt,
      lastUsedAt: entry.lastUsedAt,
      lastSuccessAt: entry.lastSuccessAt,
      lastFailureAt: entry.lastFailureAt,
      unhealthySince: entry.unhealthySince,
      lastReason: entry.lastReason,
      lastErrorCode: entry.lastErrorCode,
    };
  }

  /**
   * The state a proxy is in, capacity included.
   *
   * `saturated` sits on top of the health states rather than beside them: a
   * proxy at its limit is perfectly healthy, it is just full, and conflating
   * the two would make a busy pool look like a failing one.
   */
  private stateOf(entry: ProxyEntry, now: number): ProxyState {
    const health = this.healthOf(entry, now);
    if (health === 'healthy' && !this.hasCapacity(entry)) return 'saturated';
    return health;
  }

  /** State ignoring capacity. This is what transitions are compared on. */
  private healthOf(entry: ProxyEntry, now: number): ProxyState {
    if (entry.retired) return 'retired';
    if (!this.isUsable(entry, now)) return 'cooling';
    if (entry.requests === 0) return 'untested';
    return this.isProven(entry) ? 'healthy' : 'probation';
  }

  /**
   * Runs a mutation and emits an event if it changed the proxy's health.
   *
   * Comparing before and after is what keeps the event stream honest: a second
   * failure on an already-cooling proxy is not a new transition, and emitting
   * one would make a single bad proxy look like a collapsing pool.
   */
  private transition(
    entry: ProxyEntry,
    mutate: () => void,
    reason?: string,
    errorCode?: ScrapeErrorCode,
  ): void {
    const before = this.healthOf(entry, this.now());
    mutate();
    const after = this.healthOf(entry, this.now());
    if (before === after) return;

    if (after === 'cooling' || after === 'retired') {
      entry.unhealthySince ??= this.now();
    } else {
      entry.unhealthySince = null;
      entry.blockKind = null;
    }

    this.emit(entry, before, after, reason ?? entry.lastReason, errorCode ?? entry.lastErrorCode);
  }

  /**
   * Notices cooldowns that have expired.
   *
   * A cooldown ends by the clock, not by a call, so without a sweep the moment
   * a proxy returns to rotation would never be recorded — the very thing
   * "released again at 19:26" needs. Called from `acquire` and `getStats`,
   * both of which already run at the cadence that matters.
   */
  private refresh(now: number): void {
    for (const entry of this.entries) {
      if (entry.retired || entry.cooldownUntil === null || entry.cooldownUntil > now) continue;

      const from: ProxyState = 'cooling';
      entry.cooldownUntil = null;
      entry.blocked = false;
      entry.blockKind = null;
      entry.unhealthySince = null;
      // A served cooldown is the punishment in full, so the counter starts
      // again. Carrying it over left the proxy one failure from the threshold
      // it had just cleared, which is a one-strike policy wearing a
      // three-strike name — and it never expired on its own, because a proxy
      // that cannot reach the threshold again is a proxy nothing routes to.
      //
      // `trustedSlots` is deliberately not restored with it: the failures that
      // earned the cooldown have already halved it back to the floor, and a
      // proxy comes back having to re-earn its concurrency rather than being
      // handed eight slots the moment the clock says it may try again.
      entry.consecutiveFailures = 0;
      entry.generation += 1;
      this.emit(entry, from, this.healthOf(entry, now), entry.lastReason, entry.lastErrorCode);
    }
  }

  private emit(
    entry: ProxyEntry,
    from: ProxyState,
    to: ProxyState,
    reason: string | null | undefined,
    errorCode: ScrapeErrorCode | null | undefined,
  ): void {
    if (this.onEvent === null) return;
    const event: ProxyEvent = {
      at: this.now(),
      proxyId: entry.id,
      label: entry.label,
      from,
      to,
      blockKind: entry.blockKind,
      reason: reason ?? null,
      errorCode: errorCode ?? null,
      consecutiveFailures: entry.consecutiveFailures,
      eligibleAt: entry.cooldownUntil,
    };
    this.onEvent(event);
  }

  /** Kept short and stripped of any `user:pass@` section before it is retained. */
  private recordReason(
    entry: ProxyEntry,
    reason: string | undefined,
    errorCode: ScrapeErrorCode | undefined,
  ): void {
    if (reason !== undefined) {
      const redacted = redactEntry(reason);
      entry.lastReason =
        redacted.length > MAX_REASON_LENGTH ? `${redacted.slice(0, MAX_REASON_LENGTH)}…` : redacted;
    }
    if (errorCode !== undefined) {
      entry.lastErrorCode = errorCode;
    }
  }

  private isUsable(entry: ProxyEntry, now: number): boolean {
    if (entry.retired) return false;
    return entry.cooldownUntil === null || entry.cooldownUntil <= now;
  }

  private hasCapacity(entry: ProxyEntry): boolean {
    return entry.inFlight < this.capacityOf(entry);
  }

  /**
   * Chooses the proxy for the next lease from those with a free slot.
   *
   * Two tiers, split on whether the proxy has ever succeeded. The established
   * tier serves most leases; a fixed share is reserved for the unproven one so
   * that a proxy can actually earn the success it needs to be preferred.
   *
   * The reservation is only spent when there was something to spend it on: if
   * the established tier is empty — the whole of a run's warm-up — or every
   * member of it is full, the unproven tier serves the lease for free. That
   * keeps the share a bound on *deliberate* exploration rather than an
   * accounting of every lease an unproven proxy happens to get.
   */
  private select(free: readonly ProxyEntry[]): ProxyEntry {
    const established = free.filter((entry) => entry.successes > 0);
    const unproven = free.filter((entry) => entry.successes === 0);

    if (unproven.length === 0) return this.pickEstablished(established);
    if (established.length === 0) return pickUnproven(unproven);

    if (this.explorationPeriod > 0 && this.exploreCredit >= this.explorationPeriod - 1) {
      this.exploreCredit = 0;
      return pickUnproven(unproven);
    }
    this.exploreCredit += 1;
    return this.pickEstablished(established);
  }

  /**
   * Least-loaded then least-recently-used, with load measured as a *fraction*
   * of the proxy's own capacity.
   *
   * Normalising is what makes the preference for a good proxy real but bounded:
   * an eight-slot proxy holding two jobs is a quarter full and outranks a
   * two-slot proxy holding one, so traffic fills proxies in proportion to what
   * they have earned rather than levelling every proxy at the same raw count.
   * It also settles the case the old strict tier existed for — a suspect proxy
   * on one slot holding one slow request reads as completely full, so load
   * ordering cannot steer the batch back into it between attempts.
   *
   * LRU breaks the tie because `Date.now()` cannot: many leases land in the
   * same millisecond once requests run concurrently, and a wall-clock tie would
   * keep returning the same proxy.
   */
  private pickEstablished(entries: readonly ProxyEntry[]): ProxyEntry {
    return entries.reduce((best, entry) => {
      const load = entry.inFlight / this.capacityOf(entry);
      const bestLoad = best.inFlight / this.capacityOf(best);
      if (Math.abs(load - bestLoad) > LOAD_EPSILON) return load < bestLoad ? entry : best;
      return entry.lastUsedSeq < best.lastUsedSeq ? entry : best;
    });
  }

  /**
   * How many jobs this proxy may hold right now.
   *
   * Capacity is earned, not switched on: `trustedSlots` doubles with each
   * success and halves with each failure, so it tracks demonstrated reliability
   * rather than the single most recent outcome. Keying it on the last outcome
   * meant any one failure dropped an otherwise excellent proxy to the floor,
   * and — since real proxies fail intermittently — nearly everything sat at the
   * floor nearly always, making pool capacity equal to the number of usable
   * proxies rather than to `proxies × limit`.
   *
   * With no limit configured there is no budget to ration, so the only bound
   * that still earns its keep is the one on proxies that have never worked:
   * they stay at the floor, everything else is unbounded.
   */
  private capacityOf(entry: ProxyEntry): number {
    if (this.maxConcurrentPerProxy <= 0) {
      return entry.successes > 0 ? Number.POSITIVE_INFINITY : this.probationConcurrency;
    }
    return Math.min(this.maxConcurrentPerProxy, entry.trustedSlots);
  }

  /** A success doubles the slots the proxy is trusted with, up to the ceiling. */
  private earnTrust(entry: ProxyEntry): void {
    const ceiling =
      this.maxConcurrentPerProxy <= 0 ? Number.POSITIVE_INFINITY : this.maxConcurrentPerProxy;
    entry.trustedSlots = Math.min(ceiling, entry.trustedSlots * 2);
  }

  /**
   * A non-success halves them, never below the floor.
   *
   * Halving rather than collapsing is the point: a proxy with a good record
   * still carries most of it after one bad request, and only a run of failures
   * walks it back down — by which point the cooldown threshold has it anyway.
   */
  private loseTrust(entry: ProxyEntry): void {
    entry.trustedSlots = Math.max(this.probationConcurrency, Math.floor(entry.trustedSlots / 2));
  }

  /** Has worked at least once, and has nothing unresolved against it since. */
  private isProven(entry: ProxyEntry): boolean {
    return entry.successes > 0 && entry.consecutiveFailures === 0;
  }

  /** Broadcast wake-up: every waiter re-checks, which cannot lose a wakeup. */
  private wakeWaiters(): void {
    if (this.waiters.length === 0) return;
    const waiting = this.waiters;
    this.waiters = [];
    for (const wake of waiting) wake();
  }

  /**
   * Parks until something could have changed, then lets the caller re-check.
   *
   * Woken by a release, by an admission, by the abort signal, or — when
   * `timeoutMs` is set — by the clock, which is what lets `acquire` sit out a
   * cooldown or a replenish tick without a busy loop. Every path settles once
   * and cleans up both the timer and the listener; a waiter that resolved twice
   * would take a slot out from under whoever else was woken.
   */
  private waitForCapacity(
    signal: AbortSignal | undefined,
    timeoutMs: number | null,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      let cancelTimer: CancelTimer | null = null;

      const wake = (): void => {
        if (settled) return;
        settled = true;
        cancelTimer?.();
        signal?.removeEventListener('abort', wake);
        resolve();
      };

      this.waiters.push(wake);
      signal?.addEventListener('abort', wake, { once: true });
      if (timeoutMs !== null) cancelTimer = this.setTimer(wake, Math.max(0, timeoutMs));
    });
  }
}

/**
 * `setTimeout`, deliberately without `unref`.
 *
 * A pending acquire-wait is a job blocked on this timer for its answer, and the
 * replenish loop that could unblock it is itself unref'd — so letting the
 * process exit here would end a run mid-flight with nothing written. The wait is
 * bounded by `acquireWaitMs`, which bounds how long this can hold the loop open.
 */
function defaultSetTimer(fn: () => void, ms: number): CancelTimer {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
}

/**
 * The least-tried unproven proxy, then least-recently-used.
 *
 * Fewest requests first is what bounds the wait for a *newly admitted* proxy:
 * with zero requests it is always the next one explored, so admission to first
 * traffic takes about one exploration period rather than however long it takes
 * every established proxy to fill up. It also spends the exploration budget on
 * the least-known proxy rather than re-testing one that has already had its
 * chances — those are the ones the failure threshold is busy retiring.
 */
function pickUnproven(entries: readonly ProxyEntry[]): ProxyEntry {
  return entries.reduce((best, entry) => {
    if (entry.requests !== best.requests) return entry.requests < best.requests ? entry : best;
    return entry.lastUsedSeq < best.lastUsedSeq ? entry : best;
  });
}

/** Stable, non-reversible, and short enough to read in a table. */
function fingerprint(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 4);
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

/**
 * The default: no proxies configured, every request goes out directly.
 * Keeps the runner's proxy path exercised without needing credentials.
 */
export class NullProxyPool implements ProxyPool {
  acquire(): Promise<ProxyLease | null> {
    return Promise.resolve(null);
  }
  release(): void {}
  reportSuccess(): void {}
  reportFailure(): void {}
  reportUnsuitable(): void {}
  markBlocked(): void {}
  getStats(): ProxyPoolStats {
    return {
      configured: 0,
      available: 0,
      inUse: 0,
      blocked: 0,
      retired: 0,
      untested: 0,
      cooling: 0,
      saturated: 0,
      totalInFlight: 0,
      capacity: null,
      poolExhaustedCount: 0,
      totalRequests: 0,
      totalFailures: 0,
      source: null,
      evicted: [],
      evictionCount: 0,
      perProxy: [],
    };
  }
}
