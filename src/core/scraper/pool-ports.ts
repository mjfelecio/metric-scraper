import { type Platform } from '../models/platform.js';

import { type ProxyLease, type SessionLease } from './lease-ports.js';

export interface ProxyHealth {
  id: string;
  requests: number;
  successes: number;
  failures: number;
  /** Failures attributed to the exit node being wrong for the target (HTTP 451). */
  unsuitable: number;
  /** Consecutive failures since the last success. Drives cooldown. */
  consecutiveFailures: number;
  blocked: boolean;
  /** Permanently out of rotation: a jurisdiction block does not expire. */
  retired: boolean;
  /** Epoch ms until which this proxy is out of rotation, if any. */
  cooldownUntil: number | null;
  inUse: boolean;
}

export interface ProxyPoolStats {
  configured: number;
  available: number;
  inUse: number;
  blocked: number;
  /** Proxies retired as unsuitable exit nodes. Never come back. */
  retired: number;
  totalRequests: number;
  totalFailures: number;
  perProxy: ProxyHealth[];
}

/**
 * Rotation and health tracking for outbound IPs.
 *
 * `acquire` returning `null` is a first-class case: it means "no proxies are
 * configured, go direct". That is the default for local development, and it is
 * why nothing in this repository needs proxy credentials to run.
 */
export interface ProxyPool {
  acquire(signal?: AbortSignal): Promise<ProxyLease | null>;
  /** Return a lease to rotation without changing its health. */
  release(lease: ProxyLease): void;
  reportSuccess(lease: ProxyLease): void;
  reportFailure(lease: ProxyLease, reason?: string): void;
  /**
   * The exit node is wrong for this target rather than failing (HTTP 451).
   *
   * Distinct from `reportFailure` because a cooldown cannot fix a jurisdiction:
   * repeat it and the proxy is retired for good instead of returning in 60 s.
   */
  reportUnsuitable(lease: ProxyLease, reason?: string): void;
  /** Take a proxy out of rotation (detected block / hard ban). */
  markBlocked(lease: ProxyLease, reason?: string): void;
  getStats(): ProxyPoolStats;
}

export interface SessionHealth {
  id: string;
  platform: Platform;
  proxyId: string | null;
  requests: number;
  failures: number;
  consecutiveFailures: number;
  blocked: boolean;
  cooldownUntil: number | null;
  inUse: boolean;
}

export interface SessionPoolStats {
  configured: number;
  available: number;
  inUse: number;
  blocked: number;
  perSession: SessionHealth[];
}

/**
 * Rotation for logged-in platform identities.
 *
 * Whether either platform requires a session is an open question — see the
 * README. `acquire` returning `null` means "run anonymously", which is the
 * graceful-degradation path the runner already takes.
 */
export interface SessionPool {
  acquire(
    platform: Platform,
    signal?: AbortSignal,
    proxyId?: string | null,
  ): Promise<SessionLease | null>;
  release(lease: SessionLease): void;
  reportSuccess(lease: SessionLease): void;
  reportFailure(lease: SessionLease, reason?: string): void;
  markBlocked(lease: SessionLease, reason?: string): void;
  getStats(): SessionPoolStats;
}
