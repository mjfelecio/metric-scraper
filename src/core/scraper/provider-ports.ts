import { type ScrapeErrorCode } from '../models/errors.js';
import { type Platform } from '../models/platform.js';

import { type ProxyLease, type ProxyOutcome } from './lease-ports.js';
import { type ProxyPoolStats } from './pool-ports.js';

/**
 * Which kind of proxy the run is going out through.
 *
 * - `static` — a roster of concrete `IP:PORT` endpoints we own the health of.
 * - `rotating-residential` — one gateway; the provider picks the exit IP, and
 *   we never learn which one we got.
 */
export type ProxyMode = 'static' | 'rotating-residential';

/**
 * What the runner can tell a provider about the attempt it is about to make.
 *
 * The static provider ignores everything but the signal. It exists for the
 * residential side: a sticky-session strategy needs to know which job and which
 * attempt is asking, so that the same job can keep an exit IP across retries
 * while different jobs get different ones. Nothing derives a session id yet —
 * this is the seam that lets one be added without touching the port.
 */
export interface ProxyRequestContext {
  readonly platform: Platform;
  /** 1-based attempt number within the runner's retry loop. */
  readonly attempt: number;
  readonly signal?: AbortSignal | undefined;
}

/** Why an attempt ended as it did. Redacted before it reaches here. */
export interface ProxyOutcomeDetail {
  readonly reason?: string | undefined;
  readonly errorCode?: ScrapeErrorCode | undefined;
}

export interface ProxyProviderStats extends ProxyPoolStats {
  readonly mode: ProxyMode;
}

/**
 * How the runner gets an outbound route for one attempt.
 *
 * Deliberately narrower than {@link ProxyPool}: a lease is acquired, used, and
 * handed back with a verdict. The four-way health vocabulary
 * (`reportSuccess`/`reportFailure`/`reportUnsuitable`/`markBlocked`) is a
 * *static pool* concept — a residential gateway has no roster to bench — so it
 * lives behind this port rather than in the runner.
 *
 * Providers do not retry. Retry is the runner's, and stays there; a provider
 * that retried internally would multiply the configured attempt budget.
 */
export interface ProxyProvider {
  readonly mode: ProxyMode;
  /**
   * `null` means "go direct".
   *
   * A first-class case for `static`, where it is the default with no proxies
   * configured. Never returned by a residential provider: silently falling back
   * to the origin IP would defeat the point of the run.
   */
  acquire(context: ProxyRequestContext): Promise<ProxyLease | null>;
  /**
   * Hand the lease back with what the attempt said about it.
   *
   * Synchronous, matching the pool's report methods, so the runner's retry loop
   * keeps its current control flow. Always called exactly once per successful
   * `acquire`, including for `neutral` outcomes.
   */
  release(lease: ProxyLease, outcome: ProxyOutcome, detail?: ProxyOutcomeDetail): void;
  getStats(): ProxyProviderStats;
}
