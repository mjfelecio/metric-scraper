import { type Platform } from '../models/platform.js';

export type ProxyProtocol = 'http' | 'https' | 'socks4' | 'socks5';

/**
 * Connection details for one proxy. May contain credentials, so it is never
 * logged or serialized — logging and summaries use `ProxyLease.id` instead.
 */
export interface ProxyTarget {
  readonly protocol: ProxyProtocol;
  readonly host: string;
  readonly port: number;
  readonly username: string | null;
  readonly password: string | null;
  /** Full URL including credentials, for transports that want a single string. */
  readonly url: string;
}

/** A proxy checked out for the duration of one attempt. */
export interface ProxyLease {
  /** Stable, credential-free identifier, e.g. `http://proxy-a.example.net:8000`. */
  readonly id: string;
  /** Health epoch observed at checkout; used to ignore stale concurrent outcomes. */
  readonly generation: number;
  readonly target: ProxyTarget;
}

/**
 * Credentials/cookies for one platform identity.
 *
 * Nothing in this repository creates sessions: whether either platform needs a
 * logged-in session at all is an open question for the acquisition research.
 * The pool exists so that answer can be plugged in without touching the runner.
 */
export interface PlatformSession {
  readonly id: string;
  readonly platform: Platform;
  /** Credential-free proxy id this account is pinned to; `null` means direct-only. */
  readonly proxyId: string | null;
  /** Raw `Cookie` header value. Supplied by operators; never generated here. */
  readonly cookie: string;
  readonly userAgent: string | null;
  readonly headers: Readonly<Record<string, string>>;
}

export interface SessionLease {
  readonly id: string;
  readonly session: PlatformSession;
}

/** How a lease was used, reported back so the pool can track health. */
export type LeaseOutcome = 'success' | 'failure' | 'blocked';

/**
 * What one attempt said about the proxy it went out through.
 *
 * Wider than `LeaseOutcome` because a proxy has two failure modes a session
 * does not:
 *
 * - `unsuitable` — the exit node itself is wrong for this target (HTTP 451
 *   from a jurisdiction that blocks the platform). A cooldown does not fix
 *   that, so it is tracked separately from transient failure.
 * - `neutral`    — the attempt says nothing about the proxy (cancelled before
 *   it ran, a parse error that any exit node would have produced). Crediting
 *   these as success is what let a dead proxy keep resetting its own health.
 */
export type ProxyOutcome = LeaseOutcome | 'unsuitable' | 'neutral';
