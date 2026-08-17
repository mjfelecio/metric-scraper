import { type Logger, nullLogger } from '../../core/logging/logger.js';
import { type Platform } from '../../core/models/platform.js';
import { type PlatformSession, type SessionLease } from '../../core/scraper/lease-ports.js';
import {
  type SessionHealth,
  type SessionPool,
  type SessionPoolStats,
} from '../../core/scraper/pool-ports.js';

export interface InMemorySessionPoolOptions {
  sessions: readonly PlatformSession[];
  maxConsecutiveFailures?: number | undefined;
  cooldownMs?: number | undefined;
  logger?: Logger | undefined;
  now?: (() => number) | undefined;
}

interface SessionEntry {
  readonly session: PlatformSession;
  requests: number;
  failures: number;
  consecutiveFailures: number;
  blocked: boolean;
  cooldownUntil: number | null;
  inUse: boolean;
  lastUsedAt: number;
}

/**
 * Least-recently-used rotation over operator-supplied sessions, with the same
 * health/cooldown model as the proxy pool.
 *
 * Graceful degradation is the important behaviour: if no session is available
 * for a platform — none configured, or all cooling down — `acquire` returns
 * `null` and the attempt proceeds anonymously rather than failing the run.
 * Whether anonymous access is sufficient is exactly what the acquisition
 * research needs to answer.
 */
export class InMemorySessionPool implements SessionPool {
  private readonly entries: SessionEntry[];
  private readonly maxConsecutiveFailures: number;
  private readonly cooldownMs: number;
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(options: InMemorySessionPoolOptions) {
    this.now = options.now ?? (() => Date.now());
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 3;
    this.cooldownMs = options.cooldownMs ?? 300_000;
    this.logger = options.logger ?? nullLogger;
    this.entries = options.sessions.map((session) => ({
      session,
      requests: 0,
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

  acquire(
    platform: Platform,
    _signal?: AbortSignal,
    proxyId: string | null = null,
  ): Promise<SessionLease | null> {
    const now = this.now();
    const usable = this.entries.filter(
      (entry) =>
        entry.session.platform === platform &&
        entry.session.proxyId === proxyId &&
        this.isUsable(entry, now),
    );

    if (usable.length === 0) {
      if (this.entries.some((entry) => entry.session.platform === platform)) {
        this.logger.warn(
          { platform, proxy_id: proxyId },
          'no healthy session is bound to the leased proxy; continuing anonymously',
        );
      }
      return Promise.resolve(null);
    }

    const chosen = usable.reduce((oldest, entry) =>
      entry.lastUsedAt < oldest.lastUsedAt ? entry : oldest,
    );
    chosen.inUse = true;
    chosen.lastUsedAt = now;
    chosen.requests += 1;

    return Promise.resolve({ id: chosen.session.id, session: chosen.session });
  }

  release(lease: SessionLease): void {
    const entry = this.find(lease);
    if (entry !== undefined) {
      entry.inUse = false;
    }
  }

  reportSuccess(lease: SessionLease): void {
    const entry = this.find(lease);
    if (entry === undefined) return;
    entry.consecutiveFailures = 0;
    entry.cooldownUntil = null;
  }

  reportFailure(lease: SessionLease, reason?: string): void {
    const entry = this.find(lease);
    if (entry === undefined) return;
    entry.failures += 1;
    entry.consecutiveFailures += 1;
    if (entry.consecutiveFailures >= this.maxConsecutiveFailures) {
      entry.cooldownUntil = this.now() + this.cooldownMs;
      this.logger.warn(
        { session_id: entry.session.id, reason: reason ?? null },
        'session entered cooldown after consecutive failures',
      );
    }
  }

  markBlocked(lease: SessionLease, reason?: string): void {
    const entry = this.find(lease);
    if (entry === undefined) return;
    entry.failures += 1;
    entry.consecutiveFailures += 1;
    entry.blocked = true;
    entry.cooldownUntil = this.now() + this.cooldownMs;
    this.logger.warn(
      { session_id: entry.session.id, reason: reason ?? null },
      'session marked blocked',
    );
  }

  getStats(): SessionPoolStats {
    const now = this.now();
    const perSession: SessionHealth[] = this.entries.map((entry) => ({
      id: entry.session.id,
      platform: entry.session.platform,
      proxyId: entry.session.proxyId,
      requests: entry.requests,
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
      perSession,
    };
  }

  private isUsable(entry: SessionEntry, now: number): boolean {
    return entry.cooldownUntil === null || entry.cooldownUntil <= now;
  }

  private find(lease: SessionLease): SessionEntry | undefined {
    return this.entries.find((entry) => entry.session.id === lease.id);
  }
}

/** The default: run anonymously. No sessions are assumed to be required. */
export class NullSessionPool implements SessionPool {
  acquire(): Promise<SessionLease | null> {
    return Promise.resolve(null);
  }
  release(): void {}
  reportSuccess(): void {}
  reportFailure(): void {}
  markBlocked(): void {}
  getStats(): SessionPoolStats {
    return { configured: 0, available: 0, inUse: 0, blocked: 0, perSession: [] };
  }
}
