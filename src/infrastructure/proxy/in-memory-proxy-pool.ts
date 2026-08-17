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
  inUse: boolean;
  /** Used for least-recently-used rotation. */
  lastUsedAt: number;
}

/**
 * Single-process proxy rotation with health tracking.
 *
 * Rotation is least-recently-used, which spreads load evenly and keeps any one
 * IP from being hammered. A proxy that fails repeatedly enters a cooldown; a
 * proxy explicitly marked blocked stays out until the cooldown expires.
 *
 * Leases are not exclusive: several in-flight requests may share a proxy when
 * concurrency exceeds the pool size. Making leases exclusive (or per-proxy
 * concurrency-capped) is a natural extension once real throughput limits per
 * IP are known.
 */
export class InMemoryProxyPool implements ProxyPool {
  private readonly entries: ProxyEntry[];
  private readonly maxConsecutiveFailures: number;
  private readonly cooldownMs: number;
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(options: InMemoryProxyPoolOptions) {
    this.now = options.now ?? (() => Date.now());
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 3;
    this.cooldownMs = options.cooldownMs ?? 60_000;
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
      inUse: false,
      lastUsedAt: 0,
    }));
  }

  get size(): number {
    return this.entries.length;
  }

  acquire(): Promise<ProxyLease | null> {
    if (this.entries.length === 0) {
      return Promise.resolve(null);
    }

    const now = this.now();
    const usable = this.entries.filter((entry) => this.isUsable(entry, now));

    if (usable.length === 0) {
      // Every proxy is cooling down. Failing loudly is better than silently
      // going direct, which would expose the origin IP.
      throw new ScrapeError({
        code: 'proxy_error',
        message: `all ${this.entries.length} configured proxies are blocked or cooling down`,
        retryable: true,
      });
    }

    const chosen = usable.reduce((oldest, entry) =>
      entry.lastUsedAt < oldest.lastUsedAt ? entry : oldest,
    );

    chosen.inUse = true;
    chosen.lastUsedAt = now;
    chosen.requests += 1;

    return Promise.resolve({ id: chosen.id, target: chosen.target });
  }

  release(lease: ProxyLease): void {
    const entry = this.find(lease);
    if (entry !== undefined) {
      entry.inUse = false;
    }
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
      inUse: entry.inUse,
    }));

    return {
      configured: this.entries.length,
      available: this.entries.filter((entry) => this.isUsable(entry, now)).length,
      inUse: this.entries.filter((entry) => entry.inUse).length,
      blocked: this.entries.filter((entry) => entry.blocked).length,
      totalRequests: this.entries.reduce((total, entry) => total + entry.requests, 0),
      totalFailures: this.entries.reduce((total, entry) => total + entry.failures, 0),
      perProxy,
    };
  }

  private isUsable(entry: ProxyEntry, now: number): boolean {
    return entry.cooldownUntil === null || entry.cooldownUntil <= now;
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
