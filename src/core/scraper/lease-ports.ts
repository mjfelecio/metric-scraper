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
