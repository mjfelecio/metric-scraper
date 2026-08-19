import { type ScrapeErrorCode } from '../models/errors.js';
import { type Platform } from '../models/platform.js';

import { type ProxyLease, type SessionLease } from './lease-ports.js';
import { type ProxySourceStats } from './proxy-source-ports.js';

/**
 * What a proxy is doing right now, as one readable value.
 *
 * These conditions were always in the pool — spread across `blocked`,
 * `retired`, `cooldownUntil` and a private capacity rule — so nothing outside
 * it could name the state a proxy was in. This is a projection of those fields,
 * never a second source of truth: rotation still reads the fields themselves.
 *
 * Listed most consequential first, which is the order the state is resolved in:
 * a retired proxy is never described as merely idle.
 */
export const PROXY_STATES = [
  /** Permanently out. The exit node is in the wrong place for this target. */
  'retired',
  /** Out of rotation until `eligibleAt`. */
  'cooling',
  /**
   * Configured, but nothing has been sent through it yet.
   *
   * A proxy leaves this state the moment it is first leased, not when the
   * outcome lands — until that outcome it is on `probation`, which is exactly
   * the capacity it is being given. So this only ever appears in a snapshot,
   * never as the `from` of a transition.
   */
  'untested',
  /**
   * Usable, with an unresolved failure against it: never succeeded, or failing
   * since its last success.
   *
   * Says nothing on its own about how much work it may take — capacity is
   * earned per proxy and reported in `capacity`. A proxy with a long good
   * record still holds several slots here; one that has never succeeded holds
   * exactly one.
   */
  'probation',
  /** Proven and usable, but every slot it has is taken right now. */
  'saturated',
  /** Proven, with spare capacity. */
  'healthy',
] as const;

export type ProxyState = (typeof PROXY_STATES)[number];

/**
 * Why a proxy is out of rotation. `null` whenever it is usable.
 *
 * The distinction matters for reading a run back: `consecutive_failures` is the
 * pool benching something that kept failing, `detected_block` is the platform
 * telling us so, and `unsuitable_exit` is a jurisdiction, which no cooldown
 * fixes.
 */
export type ProxyBlockKind = 'consecutive_failures' | 'detected_block' | 'unsuitable_exit';

/** Usable states, in the sense `acquire` uses: eligible to be handed out. */
export function isUsableState(state: ProxyState): boolean {
  return state !== 'retired' && state !== 'cooling';
}

export interface ProxyHealth {
  id: string;
  /** `p1`…`pN`, assigned in admission order. Stable for the pool's life. */
  label: string;
  /**
   * Where this entry came from: `config` for a statically configured proxy, or
   * the name of the source that supplied it. Config entries are never evicted.
   */
  source: string;
  /** Epoch ms when it entered the roster. Differs from `firstUsedAt` for a
   * proxy admitted but not yet leased. */
  admittedAt: number;
  state: ProxyState;
  /** Set only while the proxy is out of rotation. */
  blockKind: ProxyBlockKind | null;
  requests: number;
  successes: number;
  failures: number;
  /** Failures attributed to the exit node being wrong for the target (HTTP 451). */
  unsuitable: number;
  /** Consecutive failures since the last success. Drives cooldown. */
  consecutiveFailures: number;
  /** Consecutive unsuitable outcomes since the last success. Drives retirement. */
  consecutiveUnsuitable: number;
  blocked: boolean;
  /** Permanently out of rotation: a jurisdiction block does not expire. */
  retired: boolean;
  /** Epoch ms until which this proxy is out of rotation, if any. */
  cooldownUntil: number | null;
  /** When it becomes eligible again. `null` when usable now, or gone for good. */
  eligibleAt: number | null;
  inUse: boolean;
  /** Jobs holding a lease right now. `inUse` is this being non-zero. */
  inFlight: number;
  /**
   * Jobs it may hold right now: the concurrency it has earned, capped by the
   * configured per-proxy limit. `null` means unlimited.
   */
  capacity: number | null;
  /** Epoch ms of the first lease ever taken on it; `null` if never used. */
  firstUsedAt: number | null;
  lastUsedAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  /** When it entered its current out-of-rotation state; `null` while usable. */
  unhealthySince: number | null;
  /** Last non-success reason, redacted and truncated. Never contains credentials. */
  lastReason: string | null;
  lastErrorCode: ScrapeErrorCode | null;
}

export interface ProxyPoolStats {
  configured: number;
  available: number;
  /** Proxies holding at least one lease right now. */
  inUse: number;
  blocked: number;
  /** Proxies retired as unsuitable exit nodes. Never come back. */
  retired: number;
  /** Configured but never yet used. */
  untested: number;
  /** Benched, waiting out a cooldown. */
  cooling: number;
  /** Usable but with every slot taken — capacity pressure, not ill health. */
  saturated: number;
  /** Leases held across the whole pool. The denominator for load skew. */
  totalInFlight: number;
  /**
   * Sum of per-proxy capacity for usable proxies. `null` when unlimited.
   *
   * The pool's *actual* ceiling, not `proxies × limit`: capacity is earned, so
   * this is what a configured `SCRAPER_CONCURRENCY` is really competing for.
   */
  capacity: number | null;
  /**
   * Times `acquire` found nothing usable and threw.
   *
   * The pool's own definition of total degradation. Until now it surfaced only
   * as a retryable error on some job, which is indistinguishable from an
   * upstream failure when reading a summary back.
   */
  poolExhaustedCount: number;
  totalRequests: number;
  totalFailures: number;
  /**
   * Candidate-supply counters, when a dynamic source is configured.
   *
   * Published here rather than alongside so that one snapshot answers both
   * "what is the pool doing" and "where is its capacity coming from" — the
   * dashboard and the run summary already carry this object.
   */
  source: ProxySourceStats | null;
  perProxy: ProxyHealth[];
}

/**
 * One change of proxy health, emitted as it happens.
 *
 * Only real transitions are emitted — `healthy ⇄ saturated` is capacity, not
 * health, and would otherwise flap on every lease. That keeps the volume bound
 * to state changes rather than to request count, which is what makes this
 * affordable to persist.
 */
export interface ProxyEvent {
  /** Epoch ms. Serialized as ISO by whatever writes it down. */
  at: number;
  proxyId: string;
  label: string;
  from: ProxyState;
  to: ProxyState;
  blockKind: ProxyBlockKind | null;
  /**
   * Why the proxy was last benched, redacted and truncated. Never contains
   * credentials. On a recovery row this says what it is coming back *from* —
   * `from`/`to` are what say which direction the proxy moved.
   */
  reason: string | null;
  errorCode: ScrapeErrorCode | null;
  consecutiveFailures: number;
  /** When the proxy becomes eligible again, for a transition into `cooling`. */
  eligibleAt: number | null;
}

/** Notified on every proxy health transition. Must not throw. */
export type ProxyEventListener = (event: ProxyEvent) => void;

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
  reportFailure(lease: ProxyLease, reason?: string, errorCode?: ScrapeErrorCode): void;
  /**
   * The exit node is wrong for this target rather than failing (HTTP 451).
   *
   * Distinct from `reportFailure` because a cooldown cannot fix a jurisdiction:
   * repeat it and the proxy is retired for good instead of returning in 60 s.
   */
  reportUnsuitable(lease: ProxyLease, reason?: string, errorCode?: ScrapeErrorCode): void;
  /** Take a proxy out of rotation (detected block / hard ban). */
  markBlocked(lease: ProxyLease, reason?: string, errorCode?: ScrapeErrorCode): void;
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
