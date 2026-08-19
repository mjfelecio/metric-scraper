import { type Logger, nullLogger } from '../../core/logging/logger.js';
import { type ProxyTarget } from '../../core/scraper/lease-ports.js';
import { type ProxyHealth } from '../../core/scraper/pool-ports.js';
import {
  CONFIG_SOURCE,
  type CandidateState,
  type ProxyProbe,
  type ProxyRoster,
  type ProxySource,
  type ProxySourceStats,
  type RejectionReason,
} from '../../core/scraper/proxy-source-ports.js';

import { proxyId, redactEntry } from './proxy-config.js';

/** Reasons are for reading, not parsing. */
const MAX_REASON_LENGTH = 120;

/**
 * Validation rounds `start` will run chasing the minimum healthy pool size.
 *
 * More than one is needed because most candidates on a free list fail: a single
 * pass probes exactly the deficit, so a 40% pass rate leaves the floor unmet.
 * Bounded because the floor may simply be unreachable, and burning through
 * thousands of candidates to prove it would cost more than starting short.
 */
const MAX_BOOTSTRAP_ROUNDS = 10;

export interface ProxySourceManagerOptions {
  source: ProxySource;
  probe: ProxyProbe;
  /** The pool's membership surface. Never its leasing surface. */
  roster: ProxyRoster;
  /** Usable proxies to aim for. Replenishment stops once this is met. */
  desiredActive?: number | undefined;
  /** `start` blocks until this many are admitted, not until `desiredActive`. */
  minHealthy?: number | undefined;
  /** Simultaneous probes. Bounds the load validation puts on our own host. */
  validateConcurrency?: number | undefined;
  refreshIntervalMs?: number | undefined;
  /** Ceiling on remembered candidates, so a huge list cannot grow unbounded. */
  maxCandidates?: number | undefined;
  /** How often the capacity deficit is re-checked. */
  replenishIntervalMs?: number | undefined;
  logger?: Logger | undefined;
  now?: (() => number) | undefined;
}

interface CandidateRecord {
  readonly id: string;
  readonly target: ProxyTarget;
  state: CandidateState;
  readonly firstSeenAt: number;
  lastSeenAt: number;
  rejection: RejectionReason | null;
}

/**
 * Keeps the pool supplied with usable proxies from a large external candidate list.
 *
 * This is a membership service and nothing more. It never chooses a proxy for a
 * job, never classifies an outcome, and never second-guesses the pool's health
 * model — it only decides who is on the roster. Everything about *using* a
 * proxy stays where it already was.
 *
 * The shape of the problem is that candidates vastly outnumber usable proxies
 * and the usable subset keeps changing, so the design is deficit-driven rather
 * than list-driven: it validates as many candidates as the missing capacity
 * calls for and no more. Handing thousands of proxies to a probe loop at once
 * would be a self-inflicted network problem, and validating a proxy we have no
 * room for is work thrown away.
 */
export class ProxySourceManager {
  private readonly source: ProxySource;
  private readonly probe: ProxyProbe;
  private readonly roster: ProxyRoster;
  private readonly desiredActive: number;
  private readonly minHealthy: number;
  private readonly validateConcurrency: number;
  private readonly refreshIntervalMs: number;
  private readonly replenishIntervalMs: number;
  private readonly maxCandidates: number;
  private readonly logger: Logger;
  private readonly now: () => number;

  private readonly candidates = new Map<string, CandidateRecord>();
  /** FIFO of ids awaiting validation. Keeps harvesting off the map scan. */
  private pending: string[] = [];
  private timers: NodeJS.Timeout[] = [];
  private aborter: AbortController | null = null;
  private running = false;
  /** Guards against a slow replenish overlapping the next tick. */
  private replenishing = false;

  private fetched = 0;
  private malformed = 0;
  private duplicates = 0;
  private refreshes = 0;
  private refreshFailures = 0;
  private lastRefreshAt: number | null = null;
  private lastRefreshError: string | null = null;
  private probeSuccesses = 0;
  private probeFailures = 0;

  constructor(options: ProxySourceManagerOptions) {
    this.source = options.source;
    this.probe = options.probe;
    this.roster = options.roster;
    this.desiredActive = Math.max(1, options.desiredActive ?? 20);
    this.minHealthy = Math.max(1, Math.min(options.minHealthy ?? 5, this.desiredActive));
    this.validateConcurrency = Math.max(1, options.validateConcurrency ?? 10);
    this.refreshIntervalMs = Math.max(0, options.refreshIntervalMs ?? 900_000);
    this.replenishIntervalMs = Math.max(100, options.replenishIntervalMs ?? 2_000);
    this.maxCandidates = Math.max(1, options.maxCandidates ?? 5_000);
    this.logger = options.logger ?? nullLogger;
    this.now = options.now ?? (() => Date.now());

    this.roster.setSourceStatsProvider(() => this.getStats());
  }

  /**
   * Fills the pool to `minHealthy`, then keeps it topped up in the background.
   *
   * Waiting for `desiredActive` here would hold a run behind a target the list
   * may simply not be able to meet — free proxies fail validation far more
   * often than they pass. The floor is what scraping actually needs to begin;
   * the target is approached while it runs.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.aborter = new AbortController();

    await this.refreshOnce();
    for (let round = 0; round < MAX_BOOTSTRAP_ROUNDS; round += 1) {
      if (this.usableCount() >= this.minHealthy || this.pending.length === 0) break;
      await this.replenishOnce(this.minHealthy);
    }

    const usable = this.usableCount();
    if (usable < this.minHealthy) {
      this.logger.warn(
        { source: this.source.name, usable, min_healthy: this.minHealthy },
        'proxy source could not reach the minimum healthy pool size; starting anyway',
      );
    }

    if (this.refreshIntervalMs > 0) {
      this.timers.push(
        setInterval(() => void this.refreshOnce(), this.refreshIntervalMs).unref?.() ??
          setInterval(() => void this.refreshOnce(), this.refreshIntervalMs),
      );
    }
    this.timers.push(
      setInterval(() => void this.replenishOnce(), this.replenishIntervalMs).unref?.() ??
        setInterval(() => void this.replenishOnce(), this.replenishIntervalMs),
    );
  }

  stop(): void {
    this.running = false;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.aborter?.abort();
    this.aborter = null;
    this.roster.setSourceStatsProvider(null);
  }

  /**
   * Refetches the candidate list.
   *
   * Never throws: a source that is down, rate-limiting us, or returning
   * nonsense is a reason to keep running on the candidates we already have, not
   * a reason to fail a scrape.
   */
  async refreshOnce(): Promise<void> {
    const signal = this.aborter?.signal;
    try {
      const result = await this.source.fetch(signal);
      this.refreshes += 1;
      this.lastRefreshAt = this.now();
      this.lastRefreshError = null;
      this.fetched += result.total;
      this.malformed += result.malformed;
      this.duplicates += result.duplicates;
      this.register(result.targets);
    } catch (error) {
      this.refreshFailures += 1;
      this.lastRefreshError = shorten(
        redactEntry(error instanceof Error ? error.message : String(error)),
      );
      this.logger.warn(
        { source: this.source.name, error: this.lastRefreshError },
        'proxy source refresh failed; continuing with the candidates already held',
      );
    }
  }

  /**
   * Brings the roster back up to strength, validating only what is missing.
   *
   * Evicting first matters: a proxy that never worked and has already burned
   * its failure budget is occupying a slot a fresh candidate could use, and
   * waiting out its cooldown buys nothing when there are hundreds more waiting.
   */
  async replenishOnce(target: number = this.desiredActive): Promise<void> {
    if (this.replenishing) return;
    this.replenishing = true;
    try {
      this.reap();

      const deficit = target - this.usableCount();
      if (deficit <= 0) return;

      const batch = this.harvest(deficit);
      if (batch.length === 0) return;

      const admitted: ProxyTarget[] = [];
      await this.forEachLimited(batch, async (record) => {
        const result = await this.probe.probe(record.target, this.aborter?.signal);
        if (result.ok) {
          this.probeSuccesses += 1;
          record.state = 'admitted';
          admitted.push(record.target);
        } else {
          this.probeFailures += 1;
          this.reject(record, 'probe_failed');
        }
      });

      if (admitted.length > 0) {
        const added = this.roster.add(admitted, this.source.name);
        this.logger.info(
          {
            source: this.source.name,
            admitted: added,
            probed: batch.length,
            usable: this.usableCount(),
          },
          'admitted validated proxies into the pool',
        );
      }
    } finally {
      this.replenishing = false;
    }
  }

  getStats(): ProxySourceStats {
    let candidates = 0;
    let validating = 0;
    let admitted = 0;
    let rejected = 0;
    for (const record of this.candidates.values()) {
      if (record.state === 'candidate') candidates += 1;
      else if (record.state === 'validating') validating += 1;
      else if (record.state === 'admitted') admitted += 1;
      else rejected += 1;
    }

    return {
      name: this.source.name,
      candidates,
      validating,
      admitted,
      rejected,
      fetched: this.fetched,
      malformed: this.malformed,
      duplicates: this.duplicates,
      refreshes: this.refreshes,
      refreshFailures: this.refreshFailures,
      lastRefreshAt: this.lastRefreshAt,
      lastRefreshError: this.lastRefreshError,
      probeSuccesses: this.probeSuccesses,
      probeFailures: this.probeFailures,
      desiredActive: this.desiredActive,
    };
  }

  /**
   * Files newly seen candidates.
   *
   * A proxy already known — admitted, being validated, or rejected — only has
   * its `lastSeenAt` refreshed. That is the whole of requirement "recognise the
   * same proxy across refreshes": a rejected id reappearing in every subsequent
   * list never gets another chance, and an admitted one never has its health
   * reset by being listed again.
   */
  private register(targets: readonly ProxyTarget[]): void {
    const now = this.now();
    let added = 0;

    for (const target of targets) {
      const id = proxyId(target);
      const existing = this.candidates.get(id);
      if (existing !== undefined) {
        existing.lastSeenAt = now;
        continue;
      }
      if (this.candidates.size >= this.maxCandidates) continue;

      this.candidates.set(id, {
        id,
        target,
        state: 'candidate',
        firstSeenAt: now,
        lastSeenAt: now,
        rejection: null,
      });
      this.pending.push(id);
      added += 1;
    }

    this.logger.debug(
      { source: this.source.name, new_candidates: added, known: this.candidates.size },
      'registered proxy candidates',
    );
  }

  /** Takes up to `count` untried candidates and marks them in flight. */
  private harvest(count: number): CandidateRecord[] {
    const batch: CandidateRecord[] = [];
    while (batch.length < count && this.pending.length > 0) {
      const id = this.pending.shift();
      if (id === undefined) break;
      const record = this.candidates.get(id);
      // Skipped rather than asserted: a record can have moved on since it was
      // queued, and a stale queue entry is not an error.
      if (record === undefined || record.state !== 'candidate') continue;
      record.state = 'validating';
      batch.push(record);
    }
    return batch;
  }

  /**
   * Removes source-supplied entries that are not worth a slot.
   *
   * The rule is deliberately narrow: only a proxy that has *never* succeeded
   * and has already been benched. Anything that ever worked keeps its place and
   * serves its cooldown like any other proxy, and configured entries are never
   * touched at all — the static list has to keep behaving exactly as before.
   */
  private reap(): void {
    for (const health of this.roster.getStats().perProxy) {
      if (health.source === CONFIG_SOURCE) continue;
      if (!isHopeless(health)) continue;
      // `evict` refuses while leases are outstanding; those jobs still owe an
      // outcome, so we simply try again on the next tick.
      if (!this.roster.evict(health.id)) continue;

      const record = this.candidates.get(health.id);
      if (record !== undefined) {
        this.reject(record, health.retired ? 'retired' : 'evicted');
      }
      this.logger.debug(
        { source: this.source.name, proxy_id: health.id, state: health.state },
        'evicted a proxy that never worked; its slot goes back to the candidate pool',
      );
    }
  }

  private reject(record: CandidateRecord, reason: RejectionReason): void {
    record.state = 'rejected';
    record.rejection = reason;
  }

  private usableCount(): number {
    return this.roster.getStats().available;
  }

  /** Bounded-concurrency map. Small and local; a queue library would be more. */
  private async forEachLimited<T>(
    items: readonly T[],
    run: (item: T) => Promise<void>,
  ): Promise<void> {
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(this.validateConcurrency, items.length) },
      async () => {
        for (;;) {
          const index = cursor++;
          if (index >= items.length) return;
          await run(items[index] as T);
        }
      },
    );
    await Promise.all(workers);
  }
}

/** Never worked, and already out of rotation. Its slot is better spent. */
function isHopeless(health: ProxyHealth): boolean {
  if (health.successes > 0) return false;
  return health.state === 'cooling' || health.state === 'retired';
}

function shorten(value: string): string {
  return value.length > MAX_REASON_LENGTH ? `${value.slice(0, MAX_REASON_LENGTH)}…` : value;
}
