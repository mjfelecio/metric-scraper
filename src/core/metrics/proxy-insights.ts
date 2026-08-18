/**
 * The least a proxy row needs for this to work.
 *
 * Structural on purpose: a summary's `ProxyUsage` and a live `ProxyHealth` both
 * satisfy it, so the dashboard and a text report reach the same verdict without
 * one of them converting into the other's shape first.
 */
export interface ProxyFailureCounts {
  proxy_id: string;
  label: string;
  failures: number;
}

export interface ProxyFailureShare {
  proxyId: string;
  label: string;
  failures: number;
  /** Share of the pool's failures carried by this proxy, 0..1. */
  share: number;
}

export interface FailureConcentration {
  totalFailures: number;
  /** Worst offenders first. At most `top` entries, and only ones with failures. */
  worst: ProxyFailureShare[];
  /** Combined share carried by `worst`, 0..1. */
  topShare: number;
  /**
   * Whether the failures are the pool's problem rather than the run's.
   *
   * A handful of proxies carrying most of the failures points at those exit
   * nodes. Failures spread evenly across a healthy pool point somewhere else
   * entirely — at the platform, or at us — which is the distinction this whole
   * view exists to make, so it is computed once here rather than eyeballed
   * from a table in two different surfaces.
   */
  concentrated: boolean;
}

export interface FailureConcentrationOptions {
  /** How many proxies count as "a few". */
  top?: number | undefined;
  /** Share of failures those few must carry to call it concentrated. */
  threshold?: number | undefined;
  /**
   * How far above an even split that share must sit.
   *
   * Without this, three proxies failing equally reads as "67% on two of them",
   * which is arithmetic rather than a finding: with `top` of `n` proxies, an
   * even split already puts `top / n` of the failures in the top slots.
   */
  margin?: number | undefined;
  /** Below this many failures the split is noise, not a signal. */
  minFailures?: number | undefined;
}

/**
 * Where a run's proxy failures actually landed.
 *
 * Pure and shared, so the dashboard banner and any text report make the same
 * call from the same numbers.
 */
export function summarizeFailureConcentration(
  perProxy: readonly ProxyFailureCounts[],
  options: FailureConcentrationOptions = {},
): FailureConcentration {
  const top = options.top ?? 2;
  const threshold = options.threshold ?? 0.6;
  const margin = options.margin ?? 0.2;
  const minFailures = options.minFailures ?? 5;

  const totalFailures = perProxy.reduce((total, proxy) => total + proxy.failures, 0);
  if (totalFailures === 0) {
    return { totalFailures: 0, worst: [], topShare: 0, concentrated: false };
  }

  const worst = [...perProxy]
    .filter((proxy) => proxy.failures > 0)
    .sort((a, b) => b.failures - a.failures)
    .slice(0, top)
    .map((proxy) => ({
      proxyId: proxy.proxy_id,
      label: proxy.label,
      failures: proxy.failures,
      share: proxy.failures / totalFailures,
    }));

  const topShare = worst.reduce((total, proxy) => total + proxy.share, 0);
  // What the top slots would hold if every proxy failed equally.
  const evenShare = Math.min(1, top / perProxy.length);

  return {
    totalFailures,
    worst,
    topShare,
    // Every clause earns its place: a pool no larger than `top` makes the
    // question meaningless, a handful of failures is noise, and a share that
    // only matches an even split is arithmetic rather than a finding.
    concentrated:
      perProxy.length > top &&
      totalFailures >= minFailures &&
      topShare >= threshold &&
      topShare - evenShare >= margin,
  };
}
