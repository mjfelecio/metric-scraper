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

/**
 * How far a probe got before it stopped. `null` on a pass.
 *
 * Kept as a first-class field rather than folded into `reason` because the
 * stage is the diagnosis: `tunnel` says the host is a web server rather than a
 * proxy, `tls` says it is intercepting our traffic, and `response` says it is
 * rewriting it. A free list contains all three, and a single failure counter
 * cannot tell an operator which one it is drowning in.
 */
export type ProxyProbeStage = 'connect' | 'tunnel' | 'tls' | 'response';

export interface ProxyProbeResult {
  ok: boolean;
  /** How long the probe took, for reporting. */
  durationMs: number;
  /** Redacted, short. `null` when the probe passed. */
  reason: string | null;
  /** The stage that failed. `null` when the probe passed. */
  stage: ProxyProbeStage | null;
}

/**
 * Proof that a candidate can carry our traffic, run before it joins the pool.
 *
 * The property to establish is the one the scrapers actually depend on: within
 * the production latency budget, the proxy opens a CONNECT tunnel to an
 * arbitrary TLS origin, forwards a handshake that validates against the public
 * trust store, and returns the origin's own response unmodified. Everything
 * below that — a host merely accepting a TCP connection — is not evidence:
 * measured against a live ProxyScrape list, 76% of the candidates that pass a
 * TCP connect cannot complete a single HTTPS request.
 *
 * What it deliberately does *not* establish is whether TikTok or Instagram will
 * serve this exit node. That is target policy, it changes minute to minute, and
 * it is settled by the pool's probation tier on real jobs — which costs nothing
 * extra, because those jobs were going to run anyway.
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
  /**
   * Probe failures split by the stage that rejected them.
   *
   * The whole point of a layered probe is that the layers are distinguishable:
   * a list that fails mostly at `connect` is stale, one that fails mostly at
   * `tunnel` is full of web servers, and one failing at `tls` is being
   * intercepted. Same total, three different operator responses.
   */
  probeFailuresByStage: Readonly<Record<ProxyProbeStage, number>>;
  /**
   * Candidates ever admitted, cumulative.
   *
   * Distinct from `admitted`, which is a live gauge that drops again when a
   * proxy is evicted. Only a cumulative count can denominate the rate below.
   */
  admittedTotal: number;
  /** Of those, how many the pool ever actually leased. */
  admittedTried: number;
  /** Of those tried, how many went on to record at least one real success. */
  admittedProven: number;
  /**
   * `admittedProven / admittedTried`, or `null` before anything was tried.
   *
   * The number the validation strategy is answerable to. Denominated in
   * admissions that were *given a chance*, not in admissions: a proxy the run
   * never needed says nothing about the probe either way, and counting it as a
   * failure would make the rate fall as the pool got healthier.
   */
  admissionToFirstSuccessRate: number | null;
  /**
   * Usable capacity the manager is replenishing towards, in concurrent slots.
   *
   * Slots rather than proxies, so it is directly comparable with the run's
   * configured concurrency instead of meaning something several times smaller.
   */
  targetCapacity: number;
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
