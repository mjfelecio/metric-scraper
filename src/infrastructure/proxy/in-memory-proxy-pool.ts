import { type Logger, nullLogger } from '../../core/logging/logger.js';
import { ScrapeError } from '../../core/models/errors.js';
import { type ProxyLease, type ProxyTarget } from '../../core/scraper/lease-ports.js';
import {
  type ProxyHealth,
  type ProxyPool,
  type ProxyPoolStats,
} from '../../core/scraper/pool-ports.js';

import { proxyId } from './proxy-config.js';

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
  logger?: Logger | undefined;
  now?: (() => number) | undefined;
}

interface ProxyEntry {
  readonly id: string;
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
  /** Jobs currently holding a lease on this proxy. */
  inFlight: number;
  /** Wall-clock time of the last lease. Reported; not used for ordering. */
  lastUsedAt: number;
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
 */
export class InMemoryProxyPool implements ProxyPool {
  private readonly entries: ProxyEntry[];
  private readonly maxConsecutiveFailures: number;
  private readonly cooldownMs: number;
  private readonly maxConcurrentPerProxy: number;
  private readonly probationConcurrency: number;
  private readonly logger: Logger;
  private readonly now: () => number;
  /** Resolved on every release, so waiters re-check for a free slot. */
  private waiters: (() => void)[] = [];
  /** Monotonic checkout counter backing LRU rotation. */
  private sequence = 0;

  constructor(options: InMemoryProxyPoolOptions) {
    this.now = options.now ?? (() => Date.now());
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 3;
    this.cooldownMs = options.cooldownMs ?? 60_000;
    this.maxConcurrentPerProxy = options.maxConcurrentPerProxy ?? 0;
    this.probationConcurrency = Math.max(1, options.probationConcurrency ?? 1);
    this.logger = options.logger ?? nullLogger;
    this.entries = options.targets.map((target) => ({
      id: proxyId(target),
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
      inFlight: 0,
      lastUsedAt: 0,
      lastUsedSeq: 0,
    }));
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
      const healthy = this.entries.filter((entry) => this.isUsable(entry, now));

      if (healthy.length === 0) {
        // Every proxy is cooling down. Failing loudly is better than silently
        // going direct, which would expose the origin IP. Waiting would not
        // help either: a cooldown outlasts a sensible request timeout, so the
        // retry policy's backoff is the right place to absorb this.
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
        chosen.lastUsedSeq = ++this.sequence;
        chosen.requests += 1;
        return { id: chosen.id, target: chosen.target };
      }

      // Healthy proxies exist but all are at their concurrency limit.
      await this.waitForRelease(signal);
    }
  }

  release(lease: ProxyLease): void {
    const entry = this.find(lease);
    if (entry !== undefined && entry.inFlight > 0) {
      entry.inFlight -= 1;
    }
    this.wakeWaiters();
  }

  reportSuccess(lease: ProxyLease): void {
    const entry = this.find(lease);
    if (entry === undefined) return;
    entry.successes += 1;
    entry.consecutiveFailures = 0;
    entry.consecutiveUnsuitable = 0;
    entry.cooldownUntil = null;
  }

  reportFailure(lease: ProxyLease, reason?: string): void {
    const entry = this.find(lease);
    if (entry === undefined) return;
    entry.failures += 1;
    entry.consecutiveFailures += 1;

    if (entry.consecutiveFailures >= this.maxConsecutiveFailures) {
      entry.cooldownUntil = this.now() + this.cooldownMs;
      this.logger.warn(
        { proxy_id: entry.id, failures: entry.consecutiveFailures, reason: reason ?? null },
        'proxy entered cooldown after consecutive failures',
      );
    }
  }

  reportUnsuitable(lease: ProxyLease, reason?: string): void {
    const entry = this.find(lease);
    if (entry === undefined) return;
    entry.failures += 1;
    entry.unsuitable += 1;
    entry.consecutiveUnsuitable += 1;

    // One 451 may just be a restricted URL. Several in a row with nothing
    // working in between is the exit node's jurisdiction, which no cooldown
    // will change — so the proxy goes for good rather than returning in 60 s
    // to burn the same share of every batch.
    if (entry.consecutiveUnsuitable >= this.maxConsecutiveFailures) {
      entry.retired = true;
      entry.blocked = true;
      this.logger.warn(
        { proxy_id: entry.id, unsuitable: entry.consecutiveUnsuitable, reason: reason ?? null },
        'proxy retired: exit node is unsuitable for this target',
      );
    }
  }

  markBlocked(lease: ProxyLease, reason?: string): void {
    const entry = this.find(lease);
    if (entry === undefined) return;
    entry.failures += 1;
    entry.consecutiveFailures += 1;
    entry.blocked = true;
    entry.cooldownUntil = this.now() + this.cooldownMs;
    this.logger.warn({ proxy_id: entry.id, reason: reason ?? null }, 'proxy marked blocked');
  }

  getStats(): ProxyPoolStats {
    const now = this.now();
    const perProxy: ProxyHealth[] = this.entries.map((entry) => ({
      id: entry.id,
      requests: entry.requests,
      successes: entry.successes,
      failures: entry.failures,
      unsuitable: entry.unsuitable,
      consecutiveFailures: entry.consecutiveFailures,
      blocked: entry.blocked,
      retired: entry.retired,
      cooldownUntil: entry.cooldownUntil,
      inUse: entry.inFlight > 0,
    }));

    return {
      configured: this.entries.length,
      available: this.entries.filter((entry) => this.isUsable(entry, now)).length,
      inUse: this.entries.filter((entry) => entry.inFlight > 0).length,
      blocked: this.entries.filter((entry) => entry.blocked).length,
      retired: this.entries.filter((entry) => entry.retired).length,
      totalRequests: this.entries.reduce((total, entry) => total + entry.requests, 0),
      totalFailures: this.entries.reduce((total, entry) => total + entry.failures, 0),
      perProxy,
    };
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

  private find(lease: ProxyLease): ProxyEntry | undefined {
    return this.entries.find((entry) => entry.id === lease.id);
  }
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
      totalRequests: 0,
      totalFailures: 0,
      perProxy: [],
    };
  }
}
