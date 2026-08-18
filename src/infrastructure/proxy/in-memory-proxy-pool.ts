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
   * Jobs that may share one proxy at a time. `0` (the default) keeps the
   * historical behaviour of unlimited sharing.
   *
   * With a limit set, pool capacity becomes `proxies × limit`, which is what
   * makes adding a proxy add throughput instead of merely spreading the same
   * global concurrency across more IPs.
   */
  maxConcurrentPerProxy?: number | undefined;
  logger?: Logger | undefined;
  now?: (() => number) | undefined;
}

interface ProxyEntry {
  readonly id: string;
  readonly target: ProxyTarget;
  requests: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  blocked: boolean;
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
 * Rotation is least-recently-used, which spreads load evenly and keeps any one
 * IP from being hammered. A proxy that fails repeatedly enters a cooldown; a
 * proxy explicitly marked blocked stays out until the cooldown expires.
 *
 * Leases are shareable by default. Set `maxConcurrentPerProxy` to cap how many
 * jobs may use one IP at once; callers then wait for a slot rather than piling
 * onto the same address. Waiting here is bounded by the caller's abort signal,
 * never indefinite.
 */
export class InMemoryProxyPool implements ProxyPool {
  private readonly entries: ProxyEntry[];
  private readonly maxConsecutiveFailures: number;
  private readonly cooldownMs: number;
  private readonly maxConcurrentPerProxy: number;
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
    this.logger = options.logger ?? nullLogger;
    this.entries = options.targets.map((target) => ({
      id: proxyId(target),
      target,
      requests: 0,
      successes: 0,
      failures: 0,
      consecutiveFailures: 0,
      blocked: false,
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
        // Least-loaded first, then least-recently-used. Ordering on load
        // matters as soon as requests are genuinely concurrent: several
        // acquisitions can land in the same millisecond, and a pure LRU tie
        // then keeps returning the same proxy, quietly hammering one IP.
        const chosen = free.reduce((best, entry) => {
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
      consecutiveFailures: entry.consecutiveFailures,
      blocked: entry.blocked,
      cooldownUntil: entry.cooldownUntil,
      inUse: entry.inFlight > 0,
    }));

    return {
      configured: this.entries.length,
      available: this.entries.filter((entry) => this.isUsable(entry, now)).length,
      inUse: this.entries.filter((entry) => entry.inFlight > 0).length,
      blocked: this.entries.filter((entry) => entry.blocked).length,
      totalRequests: this.entries.reduce((total, entry) => total + entry.requests, 0),
      totalFailures: this.entries.reduce((total, entry) => total + entry.failures, 0),
      perProxy,
    };
  }

  private isUsable(entry: ProxyEntry, now: number): boolean {
    return entry.cooldownUntil === null || entry.cooldownUntil <= now;
  }

  private hasCapacity(entry: ProxyEntry): boolean {
    return this.maxConcurrentPerProxy <= 0 || entry.inFlight < this.maxConcurrentPerProxy;
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
  markBlocked(): void {}
  getStats(): ProxyPoolStats {
    return {
      configured: 0,
      available: 0,
      inUse: 0,
      blocked: 0,
      totalRequests: 0,
      totalFailures: 0,
      perProxy: [],
    };
  }
}
