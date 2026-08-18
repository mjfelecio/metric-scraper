import { createHash } from 'node:crypto';

import { type Logger, nullLogger } from '../../core/logging/logger.js';
import { ScrapeError, type ScrapeErrorCode } from '../../core/models/errors.js';
import { type ProxyLease, type ProxyTarget } from '../../core/scraper/lease-ports.js';
import {
  type ProxyBlockKind,
  type ProxyEvent,
  type ProxyEventListener,
  type ProxyHealth,
  type ProxyPool,
  type ProxyPoolStats,
  type ProxyState,
} from '../../core/scraper/pool-ports.js';

import { proxyId, redactEntry } from './proxy-config.js';

/** Reasons are for reading, not for parsing; a stack-length message helps nobody. */
const MAX_REASON_LENGTH = 200;

export interface InMemoryProxyPoolOptions {
  targets: readonly ProxyTarget[];
  /** Consecutive failures before a proxy is put in cooldown. */
  maxConsecutiveFailures?: number | undefined;
  /** How long a failed or blocked proxy stays out of rotation. */
  cooldownMs?: number | undefined;
  /**
   * Jobs that may share one proxy at a time. `0` means unlimited sharing.
   *
   * With a limit set, pool capacity becomes `proxies × limit`, which is what
   * makes adding a proxy add throughput instead of merely spreading the same
   * global concurrency across more IPs — and what keeps one IP from absorbing
   * a whole batch.
   */
  maxConcurrentPerProxy?: number | undefined;
  /**
   * In-flight requests allowed on a proxy that has not yet proved itself, or
   * whose last outcome was a failure. Defaults to 1.
   *
   * Health is evaluated at acquire time, so without this a proxy can be handed
   * to N jobs before the first of them reports anything — which is how a dead
   * IP absorbed 30 requests inside a 45 s run despite a 3-failure threshold.
   * Probation bounds the exposure to roughly `maxConsecutiveFailures`
   * requests, and only for proxies that are actually suspect.
   */
  probationConcurrency?: number | undefined;
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
  /** `p1`…`pN`, from configuration order. Short enough to scan a table by. */
  readonly label: string;
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
}

/**
 * Single-process proxy rotation with health tracking.
 *
 * Rotation is least-loaded then least-recently-used, which spreads load evenly
 * and keeps any one IP from being hammered.
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
 * Capacity is bounded twice over. `maxConcurrentPerProxy` caps a proven proxy;
 * a proxy that has never succeeded, or whose last outcome was a failure, is on
 * probation and capped far lower — health is checked when a lease is handed
 * out, so without that bound a proxy can be given to many jobs before the
 * first one reports back. Waiting for a slot is bounded by the caller's abort
 * signal, never indefinite.
 *
 * Everything an operator needs to read the pool back — the state each proxy is
 * in, when it went bad, why, and when it is due back — is derived from these
 * same fields and published through `getStats`, so an observability view can
 * never disagree with what rotation actually did.
 */
export class InMemoryProxyPool implements ProxyPool {
  private readonly entries: ProxyEntry[];
  /** Lookup by lease id. A linear scan ran on every report and every release. */
  private readonly byId: Map<string, ProxyEntry>;
  private readonly maxConsecutiveFailures: number;
  private readonly cooldownMs: number;
  private readonly maxConcurrentPerProxy: number;
  private readonly probationConcurrency: number;
  private readonly onEvent: ProxyEventListener | null;
  private readonly logger: Logger;
  private readonly now: () => number;
  /** Resolved on every release, so waiters re-check for a free slot. */
  private waiters: (() => void)[] = [];
  /** Monotonic checkout counter backing LRU rotation. */
  private sequence = 0;
  private poolExhaustedCount = 0;

  constructor(options: InMemoryProxyPoolOptions) {
    this.now = options.now ?? (() => Date.now());
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 3;
    this.cooldownMs = options.cooldownMs ?? 60_000;
    this.maxConcurrentPerProxy = options.maxConcurrentPerProxy ?? 0;
    this.probationConcurrency = Math.max(1, options.probationConcurrency ?? 1);
    this.onEvent = options.onEvent ?? null;
    this.logger = options.logger ?? nullLogger;
    this.entries = assignIdentities(options.targets, this.logger);
    this.byId = new Map(this.entries.map((entry) => [entry.id, entry]));
  }

  get size(): number {
    return this.entries.length;
  }

  async acquire(signal?: AbortSignal): Promise<ProxyLease | null> {
    if (this.entries.length === 0) {
      return null;
    }

    for (;;) {
      if (signal?.aborted === true) {
        throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
      }

      const now = this.now();
      // Expired cooldowns are noticed here rather than by a timer, so a proxy
      // coming back is recorded at the first moment it could matter.
      this.refresh(now);
      const healthy = this.entries.filter((entry) => this.isUsable(entry, now));

      if (healthy.length === 0) {
        // Every proxy is cooling down. Failing loudly is better than silently
        // going direct, which would expose the origin IP. Waiting would not
        // help either: a cooldown outlasts a sensible request timeout, so the
        // retry policy's backoff is the right place to absorb this.
        this.poolExhaustedCount += 1;
        throw new ScrapeError({
          code: 'proxy_error',
          message: `all ${this.entries.length} configured proxies are blocked or cooling down`,
          retryable: true,
        });
      }

      const free = healthy.filter((entry) => this.hasCapacity(entry));
      if (free.length > 0) {
        // Proven proxies first, then least-loaded, then least-recently-used.
        //
        // Load ordering matters as soon as requests are genuinely concurrent:
        // several acquisitions can land in the same millisecond, and a pure LRU
        // tie then keeps returning the same proxy, quietly hammering one IP.
        //
        // The proven tier sits above it because a suspect proxy holding one
        // slow request looks *idle* between attempts, so load ordering alone
        // steers the batch straight back into it. At the start of a run nothing
        // is proven yet, so the tier is flat and load still spreads evenly —
        // it only ever demotes a proxy that has actually failed us.
        const chosen = free.reduce((best, entry) => {
          if (this.isProven(entry) !== this.isProven(best)) {
            return this.isProven(entry) ? entry : best;
          }
          if (entry.inFlight !== best.inFlight) {
            return entry.inFlight < best.inFlight ? entry : best;
          }
          return entry.lastUsedSeq < best.lastUsedSeq ? entry : best;
        });
        chosen.inFlight += 1;
        chosen.lastUsedAt = now;
        chosen.firstUsedAt ??= now;
        chosen.lastUsedSeq = ++this.sequence;
        chosen.requests += 1;
        return { id: chosen.id, target: chosen.target };
      }

      // Healthy proxies exist but all are at their concurrency limit.
      await this.waitForRelease(signal);
    }
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
      entry.successes += 1;
      entry.consecutiveFailures = 0;
      entry.consecutiveUnsuitable = 0;
      entry.cooldownUntil = null;
      entry.lastSuccessAt = this.now();
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
        entry.consecutiveFailures += 1;
        entry.lastFailureAt = this.now();
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
        entry.consecutiveUnsuitable += 1;
        entry.lastFailureAt = this.now();
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
        entry.consecutiveFailures += 1;
        entry.blocked = true;
        entry.cooldownUntil = this.now() + this.cooldownMs;
        entry.blockKind = 'detected_block';
        entry.lastFailureAt = this.now();
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

    const perProxy: ProxyHealth[] = this.entries.map((entry) => ({
      id: entry.id,
      label: entry.label,
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
    }));

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
      totalRequests: perProxy.reduce((total, proxy) => total + proxy.requests, 0),
      totalFailures: perProxy.reduce((total, proxy) => total + proxy.failures, 0),
      perProxy,
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
      // Back in rotation, but not yet trusted: it still has failures against it
      // since its last success, so probation keeps its exposure small until it
      // proves itself again.
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
   * How many jobs this proxy may hold right now.
   *
   * A proxy is trusted with the full limit only once it has actually worked
   * and has no unresolved failure. Everything else — never used, or failing
   * since its last success — is on probation, which is what keeps a dead IP
   * from being handed out tens of times before the first outcome lands. The
   * gate is per proxy, so healthy IPs keep their full concurrency and nothing
   * serializes across the pool.
   */
  private capacityOf(entry: ProxyEntry): number {
    const limit =
      this.maxConcurrentPerProxy <= 0 ? Number.POSITIVE_INFINITY : this.maxConcurrentPerProxy;
    return this.isProven(entry) ? limit : Math.min(limit, this.probationConcurrency);
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

  private waitForRelease(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const wake = (): void => {
        signal?.removeEventListener('abort', wake);
        resolve();
      };
      this.waiters.push(wake);
      signal?.addEventListener('abort', wake, { once: true });
    });
  }
}

/**
 * Builds the pool's entries, giving every one a label and a unique id.
 *
 * `proxyId` is deliberately credential-free, which means two entries on the
 * same gateway host — the ordinary shape of a rotating residential pool, where
 * the username carries the session — collapse onto one id. Every outcome would
 * then be attributed to whichever entry was found first, so one proxy's
 * failures could bench another's health. A short digest of the full URL
 * separates them without putting any part of the credential in the id.
 */
function assignIdentities(targets: readonly ProxyTarget[], logger: Logger): ProxyEntry[] {
  const counts = new Map<string, number>();
  for (const target of targets) {
    const id = proxyId(target);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  return targets.map((target, index) => {
    const base = proxyId(target);
    const duplicated = (counts.get(base) ?? 0) > 1;
    if (duplicated && index === targets.findIndex((other) => proxyId(other) === base)) {
      logger.warn(
        { proxy_id: base, entries: counts.get(base) },
        'multiple proxy entries share one host:port; ids are suffixed so their health stays separate',
      );
    }

    return {
      id: duplicated ? `${base}#${fingerprint(target.url)}` : base,
      label: `p${index + 1}`,
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
      lastUsedAt: null,
      firstUsedAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      unhealthySince: null,
      lastReason: null,
      lastErrorCode: null,
      lastUsedSeq: 0,
    };
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
      perProxy: [],
    };
  }
}
