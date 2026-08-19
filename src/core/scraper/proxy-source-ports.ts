import { type ProxyTarget } from './lease-ports.js';
import { type ProxyPoolStats } from './pool-ports.js';

/** Marks entries that came from static configuration rather than a live source. */
export const CONFIG_SOURCE = 'config';

/**
 * Where a candidate sits before the pool's own health model takes over.
 *
 * Deliberately disjoint from `ProxyState`: a proxy is described by exactly one
 * of the two at any moment. `admitted` is the handoff — from that point on the
 * only meaningful answer to "what state is it in" is the `ProxyState` the pool
 * derives, and this value is never consulted again.
 */
export type CandidateState = 'candidate' | 'validating' | 'admitted' | 'rejected';

/** Why a candidate will never be tried again during this process. */
export type RejectionReason = 'probe_failed' | 'evicted' | 'retired' | 'pool_full';

export interface ProxyProbeResult {
  ok: boolean;
  /** How long the probe took, for reporting. */
  durationMs: number;
  /** Redacted, short. `null` when the probe passed. */
  reason: string | null;
}

/**
 * Cheap reachability check, run before a candidate is allowed into the pool.
 *
 * Deliberately transport-level and target-agnostic: it answers "is anything
 * listening" and nothing more. Whether a proxy is *useful* for TikTok or
 * Instagram is decided by the pool's probation tier on real traffic, which is
 * what keeps validation from becoming a second source of upstream load.
 */
export interface ProxyProbe {
  probe(target: ProxyTarget, signal?: AbortSignal): Promise<ProxyProbeResult>;
}

export interface ProxySourceFetchResult {
  targets: ProxyTarget[];
  /** Entries seen in the response, before any filtering. */
  total: number;
  /** Entries that did not parse. Counted rather than thrown: one bad line in a
   * list of thousands is expected, and must not fail the refresh. */
  malformed: number;
  /** Entries dropped because an equivalent proxy was already present. */
  duplicates: number;
}

/** A supply of candidate proxies. Never decides health, only membership. */
export interface ProxySource {
  /** Short, stable, safe to log — becomes `ProxyHealth.source`. */
  readonly name: string;
  fetch(signal?: AbortSignal): Promise<ProxySourceFetchResult>;
}

export interface ProxySourceStats {
  name: string;
  /** Known but not yet validated or admitted. */
  candidates: number;
  validating: number;
  admitted: number;
  /** Permanently out for this process. Never re-admitted on a later refresh. */
  rejected: number;
  /** Cumulative across refreshes. */
  fetched: number;
  malformed: number;
  duplicates: number;
  refreshes: number;
  refreshFailures: number;
  lastRefreshAt: number | null;
  /** Redacted and truncated. `null` when the last refresh succeeded. */
  lastRefreshError: string | null;
  probeSuccesses: number;
  probeFailures: number;
  /** Target the manager is replenishing towards. */
  desiredActive: number;
}

/**
 * The membership surface of a pool, separate from the leasing surface.
 *
 * Kept off `ProxyPool` on purpose: `NullProxyPool` has no roster to mutate, and
 * the runner has no business adding proxies. Only the source manager depends on
 * this, so only a pool that actually holds entries has to implement it.
 */
export interface ProxyRoster {
  /**
   * Adds entries that are not already present, returning how many were new.
   *
   * Ignoring ids it already holds is what stops a refresh from resetting a
   * proxy's health simply by listing it again.
   */
  add(targets: readonly ProxyTarget[], source: string): number;
  /** Removes an entry. Refuses while it still holds leases; returns success. */
  evict(id: string): boolean;
  getStats(): ProxyPoolStats;
  /** Publishes source counters through `getStats`, so there is one snapshot. */
  setSourceStatsProvider(provider: (() => ProxySourceStats) | null): void;
}
