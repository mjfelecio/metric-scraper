import { type ProxyLease, type ProxyOutcome } from '../../core/scraper/lease-ports.js';
import { type ProxyPool } from '../../core/scraper/pool-ports.js';
import {
  type ProxyOutcomeDetail,
  type ProxyProvider,
  type ProxyProviderStats,
  type ProxyRequestContext,
} from '../../core/scraper/provider-ports.js';

/**
 * The static proxy pool, behind the provider port.
 *
 * Deliberately thin: it owns the translation from one `ProxyOutcome` to the
 * pool's four report methods, and nothing else. That switch used to live in the
 * runner, which meant the runner knew about `markBlocked` and `reportUnsuitable`
 * — vocabulary that has no meaning for a rotating gateway.
 *
 * Wraps whatever pool the composition root built, `InMemoryProxyPool` or
 * `NullProxyPool` alike, so the "no proxies configured, go direct" path stays
 * exactly what it was and needs no third mode.
 */
export class StaticProxyProvider implements ProxyProvider {
  readonly mode = 'static' as const;

  constructor(private readonly pool: ProxyPool) {}

  acquire(context: ProxyRequestContext): Promise<ProxyLease | null> {
    // Platform and attempt are of no interest to the static pool: rotation is
    // its own, and a retry lands on whichever proxy is next eligible.
    return this.pool.acquire(context.signal);
  }

  release(lease: ProxyLease, outcome: ProxyOutcome, detail?: ProxyOutcomeDetail): void {
    switch (outcome) {
      case 'success':
        this.pool.reportSuccess(lease);
        break;
      case 'blocked':
        this.pool.markBlocked(lease, detail?.reason, detail?.errorCode);
        break;
      case 'unsuitable':
        this.pool.reportUnsuitable(lease, detail?.reason, detail?.errorCode);
        break;
      case 'failure':
        this.pool.reportFailure(lease, detail?.reason, detail?.errorCode);
        break;
      case 'neutral':
        // Neither credited nor blamed: the lease just goes back.
        break;
    }
    // Always, and always last: releasing is what wakes a job waiting on
    // capacity, so health must already be recorded when that job wakes.
    this.pool.release(lease);
  }

  getStats(): ProxyProviderStats {
    return { ...this.pool.getStats(), mode: this.mode };
  }
}
