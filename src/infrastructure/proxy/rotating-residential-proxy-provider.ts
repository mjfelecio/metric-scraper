import {
  type ProxyLease,
  type ProxyOutcome,
  type ProxyTarget,
} from '../../core/scraper/lease-ports.js';
import { type ProxyHealth } from '../../core/scraper/pool-ports.js';
import {
  type ProxyOutcomeDetail,
  type ProxyProvider,
  type ProxyProviderStats,
} from '../../core/scraper/provider-ports.js';

import { proxyId } from './proxy-config.js';

/** Truncation bound for the last-reason field, matching the static pool's. */
const MAX_REASON_LENGTH = 200;

export interface RotatingResidentialProxyProviderOptions {
  /** The gateway. One endpoint for the whole run; the provider picks the exit IP. */
  target: ProxyTarget;
  now?: (() => number) | undefined;
}

/**
 * One rotating residential gateway, behind the provider port.
 *
 * The whole point of this class is what it does *not* do. There is no roster,
 * no cooldown, no retirement and no capacity accounting, because none of those
 * would mean anything: every request leaves through an exit IP the provider
 * chose and will not give us again. Benching the gateway after a few failures
 * would take the entire run offline over what was, at most, evidence about one
 * IP we have already lost.
 *
 * So failures are counted and never acted upon. Rotation belongs to the
 * provider; the scraper does not attempt it.
 */
export class RotatingResidentialProxyProvider implements ProxyProvider {
  readonly mode = 'rotating-residential' as const;

  private readonly lease: ProxyLease;
  private readonly now: () => number;
  private readonly admittedAt: number;

  private requests = 0;
  private successes = 0;
  private failures = 0;
  private unsuitable = 0;
  private blockedCount = 0;
  private inFlight = 0;
  private firstUsedAt: number | null = null;
  private lastUsedAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private lastFailureAt: number | null = null;
  private lastReason: string | null = null;
  private lastErrorCode: ProxyHealth['lastErrorCode'] = null;

  constructor(options: RotatingResidentialProxyProviderOptions) {
    this.now = options.now ?? Date.now;
    this.admittedAt = this.now();
    this.lease = { id: proxyId(options.target), target: options.target };
  }

  /** The credential-free gateway id, as it appears in logs and the summary. */
  get id(): string {
    return this.lease.id;
  }

  acquire(): Promise<ProxyLease | null> {
    // Never `null`, and never blocks. Falling back to the origin IP would
    // silently turn a residential comparison run into a direct one, and there is
    // no capacity to wait for: the gateway multiplexes on the provider's side.
    this.requests += 1;
    this.inFlight += 1;
    const at = this.now();
    this.firstUsedAt ??= at;
    this.lastUsedAt = at;
    return Promise.resolve(this.lease);
  }

  release(_lease: ProxyLease, outcome: ProxyOutcome, detail?: ProxyOutcomeDetail): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const at = this.now();

    switch (outcome) {
      case 'success':
        this.successes += 1;
        this.lastSuccessAt = at;
        break;
      case 'failure':
        this.failures += 1;
        this.lastFailureAt = at;
        break;
      case 'unsuitable':
        // Recorded, but not a retirement: a residential exit in the wrong
        // jurisdiction says nothing about the next one the gateway hands out.
        this.unsuitable += 1;
        this.failures += 1;
        this.lastFailureAt = at;
        break;
      case 'blocked':
        // Likewise: the platform blocked an exit IP, not our gateway.
        this.blockedCount += 1;
        this.failures += 1;
        this.lastFailureAt = at;
        break;
      case 'neutral':
        return;
    }

    if (outcome !== 'success') {
      this.lastReason = truncate(detail?.reason);
      this.lastErrorCode = detail?.errorCode ?? null;
    }
  }

  getStats(): ProxyProviderStats {
    const used = this.firstUsedAt !== null;
    return {
      mode: this.mode,
      configured: 1,
      available: 1,
      inUse: this.inFlight > 0 ? 1 : 0,
      // Structurally zero, not merely unobserved: nothing here can bench the
      // gateway, so these can never become non-zero.
      blocked: 0,
      retired: 0,
      untested: used ? 0 : 1,
      cooling: 0,
      saturated: 0,
      totalInFlight: this.inFlight,
      // Unbounded here. The run's ceiling is SCRAPER_CONCURRENCY alone, plus
      // whatever concurrent-session cap the provider enforces on their side.
      capacity: null,
      // `acquire` cannot fail, so the pool-exhaustion counter has no analogue.
      poolExhaustedCount: 0,
      totalRequests: this.requests,
      totalFailures: this.failures,
      source: null,
      perProxy: [this.health(used)],
    };
  }

  /**
   * One synthetic row describing the gateway.
   *
   * Not a proxy roster: it is a single endpoint standing in for however many
   * exit IPs the provider actually used, which we have no way of counting. The
   * fields a residential gateway cannot have — cooldown, retirement, earned
   * capacity — are reported as their inert values rather than left undefined, so
   * the existing summary shape keeps working unchanged.
   */
  private health(used: boolean): ProxyHealth {
    return {
      id: this.lease.id,
      label: 'gateway',
      source: 'config',
      admittedAt: this.admittedAt,
      state: used ? 'healthy' : 'untested',
      blockKind: null,
      requests: this.requests,
      successes: this.successes,
      failures: this.failures,
      unsuitable: this.unsuitable,
      // Not tracked: it exists to drive a cooldown, and there is no cooldown.
      consecutiveFailures: 0,
      consecutiveUnsuitable: 0,
      blocked: false,
      retired: false,
      cooldownUntil: null,
      eligibleAt: null,
      inUse: this.inFlight > 0,
      inFlight: this.inFlight,
      capacity: null,
      firstUsedAt: this.firstUsedAt,
      lastUsedAt: this.lastUsedAt,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      unhealthySince: null,
      lastReason: this.lastReason,
      lastErrorCode: this.lastErrorCode,
    };
  }

  /** Blocked outcomes seen, for reading a run back. Never benches anything. */
  get blockedOutcomes(): number {
    return this.blockedCount;
  }
}

function truncate(reason: string | undefined): string | null {
  if (reason === undefined || reason === '') return null;
  return reason.length <= MAX_REASON_LENGTH ? reason : `${reason.slice(0, MAX_REASON_LENGTH)}…`;
}
