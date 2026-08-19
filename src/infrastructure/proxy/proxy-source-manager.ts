import { type Logger, nullLogger } from '../../core/logging/logger.js';
import { type ProxyTarget } from '../../core/scraper/lease-ports.js';
import { type ProxyHealth } from '../../core/scraper/pool-ports.js';
import {
  CONFIG_SOURCE,
  type CandidateState,
  type ProxyProbe,
  type ProxyProbeStage,
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
  /**
   * Usable *capacity* to aim for, in concurrent slots. Replenishment stops once
   * the pool can serve this many simultaneous requests.
   *
   * Slots, not proxies, because slots are what a run consumes: the caller sets
   * this from `SCRAPER_CONCURRENCY`, and the two are then denominated in the
   * same unit and cannot silently disagree. Counting proxies instead meant a
   * roster of dead entries could satisfy a target it had no way to serve.
   */
  targetCapacity?: number | undefined;
  /**
   * Capacity `start` blocks for, rather than the full `targetCapacity`.
   *
   * Doubles as the eviction floor: the roster is never reaped below this many
   * entries that could still come back. See `reap`.
   */
  minCapacity?: number | undefined;
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
  /** The stage that rejected it, when the rejection came from a probe. */
  probeStage: ProxyProbeStage | null;
  /**
   * Whether the pool ever leased it, and whether it ever worked.
   *
   * Sticky, and kept on the candidate rather than read off the pool, because
   * the pool forgets an evicted proxy entirely — and every proxy it evicts is
   * one that never succeeded. Reading the rate off the roster would therefore
   * delete exactly the failures it is meant to count, and a pool churning hard
   * would report a rate approaching 1 while achieving very little.
   */
  everTried: boolean;
  everSucceeded: boolean;
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
  private readonly targetCapacity: number;
  private readonly minCapacity: number;
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
  private readonly probeFailuresByStage: Record<ProxyProbeStage, number> = {
    connect: 0,
    tunnel: 0,
    tls: 0,
    response: 0,
  };
  private admittedTotal = 0;

  constructor(options: ProxySourceManagerOptions) {
    this.source = options.source;
    this.probe = options.probe;
    this.roster = options.roster;
    this.targetCapacity = Math.max(1, options.targetCapacity ?? 10);
    this.minCapacity = Math.max(1, Math.min(options.minCapacity ?? 5, this.targetCapacity));
    this.validateConcurrency = Math.max(1, options.validateConcurrency ?? 10);
    this.refreshIntervalMs = Math.max(0, options.refreshIntervalMs ?? 900_000);
    this.replenishIntervalMs = Math.max(100, options.replenishIntervalMs ?? 2_000);
    this.maxCandidates = Math.max(1, options.maxCandidates ?? 5_000);
    this.logger = options.logger ?? nullLogger;
    this.now = options.now ?? (() => Date.now());

    this.roster.setSourceStatsProvider(() => this.getStats());
  }

  /**
   * Fills the pool to `minCapacity`, then keeps it topped up in the background.
   *
   * Waiting for `targetCapacity` here would hold a run behind a target the list
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
      if (this.usableCapacity() >= this.minCapacity || this.pending.length === 0) break;
      await this.replenishOnce(this.minCapacity);
    }

    const capacity = this.usableCapacity();
    if (capacity < this.minCapacity) {
      this.logger.warn(
        { source: this.source.name, capacity, min_capacity: this.minCapacity },
        'proxy source could not reach the minimum usable capacity; starting anyway',
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
   * Brings usable capacity back up to strength, validating only what is missing.
   *
   * Admission runs *before* eviction, so a replacement is already on the roster
   * before anything leaves it — a swap rather than a drop and a later refill.
   * Reaping first is what let eviction outrun the replenish tick and empty the
   * roster outright, and it bought nothing: a hopeless proxy is by definition
   * cooling or retired, so it contributes no capacity and cannot mask a deficit
   * whichever order the two run in.
   */
  async replenishOnce(target: number = this.targetCapacity): Promise<void> {
    if (this.replenishing) return;
    this.replenishing = true;
    try {
      // One admitted proxy is worth at least one slot, so the capacity deficit
      // is an upper bound on how many candidates are worth probing this tick.
      const deficit = target - this.usableCapacity();
      if (deficit > 0) await this.admit(this.harvest(deficit));
      this.reap();
    } finally {
      this.replenishing = false;
    }
  }

  /** Probes a harvested batch and adds whatever passes to the roster. */
  private async admit(batch: readonly CandidateRecord[]): Promise<void> {
    if (batch.length === 0) return;

    const admitted: ProxyTarget[] = [];
    await this.forEachLimited(batch, async (record) => {
      const result = await this.probe.probe(record.target, this.aborter?.signal);
      if (result.ok) {
        this.probeSuccesses += 1;
        this.admittedTotal += 1;
        record.state = 'admitted';
        admitted.push(record.target);
      } else {
        this.probeFailures += 1;
        if (result.stage !== null) this.probeFailuresByStage[result.stage] += 1;
        this.reject(record, 'probe_failed', result.stage);
      }
    });

    if (admitted.length === 0) return;

    // `add` skips ids the pool already holds, so a candidate that is somehow
    // offered twice cannot become two entries with two separate health records.
    const added = this.roster.add(admitted, this.source.name);
    this.logger.info(
      {
        source: this.source.name,
        admitted: added,
        probed: batch.length,
        capacity: this.usableCapacity(),
      },
      'admitted validated proxies into the pool',
    );
  }

  getStats(): ProxySourceStats {
    let candidates = 0;
    let validating = 0;
    let admitted = 0;
    let rejected = 0;
    let admittedTried = 0;
    let admittedProven = 0;
    for (const record of this.candidates.values()) {
      if (record.state === 'candidate') candidates += 1;
      else if (record.state === 'validating') validating += 1;
      else if (record.state === 'admitted') admitted += 1;
      else rejected += 1;
      if (record.everTried) admittedTried += 1;
      if (record.everSucceeded) admittedProven += 1;
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
      probeFailuresByStage: { ...this.probeFailuresByStage },
      admittedTotal: this.admittedTotal,
      admittedTried,
      admittedProven,
      admissionToFirstSuccessRate: admittedTried === 0 ? null : admittedProven / admittedTried,
      targetCapacity: this.targetCapacity,
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
        probeStage: null,
        everTried: false,
        everSucceeded: false,
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
   * Removes source-supplied entries that are not worth a slot, but never the
   * last of them.
   *
   * The rule is narrow to begin with: only a proxy that has *never* succeeded
   * and has already been benched. Anything that ever worked keeps its place and
   * serves its cooldown like any other proxy, and configured entries are never
   * touched at all — the static list has to keep behaving exactly as before.
   *
   * On top of that sits a floor, because eviction with no floor is how the
   * roster reached zero and took the whole run with it. The two cases differ in
   * whether anything is being given up:
   *
   * - **retired** — the exit node is in the wrong jurisdiction and will never
   *   serve again. Keeping it protects nothing, so it always goes.
   * - **cooling** — it comes back when the cooldown expires. That is the only
   *   path back once the candidate list is exhausted, so the roster keeps at
   *   least `minCapacity` entries that could still return.
   *
   * The floor counts entries rather than slots, because entries are what
   * eviction removes; a proxy at the probation floor is worth one slot, so the
   * two units coincide exactly where this rule binds.
   */
  private reap(): void {
    const roster = this.roster.getStats().perProxy;
    this.observeSuccesses(roster);
    let viable = roster.filter((health) => !health.retired).length;

    for (const health of roster) {
      if (health.source === CONFIG_SOURCE) continue;
      if (!isHopeless(health)) continue;
      if (!health.retired && viable <= this.minCapacity) continue;
      // `evict` refuses while leases are outstanding; those jobs still owe an
      // outcome, so we simply try again on the next tick.
      if (!this.roster.evict(health.id)) continue;
      if (!health.retired) viable -= 1;

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

  private reject(
    record: CandidateRecord,
    reason: RejectionReason,
    probeStage: ProxyProbeStage | null = null,
  ): void {
    record.state = 'rejected';
    record.rejection = reason;
    record.probeStage = probeStage;
  }

  /**
   * Marks candidates the pool has since seen succeed.
   *
   * Runs on the replenish tick, and once more on `stop`, because the pool's own
   * record of a proxy disappears when it is evicted — and eviction is exactly
   * what happens to the proxies this rate is trying to count. Reading it here
   * rather than inside `getStats` is not a style choice: the pool publishes
   * these stats *through* `getStats`, so asking it for them from there would
   * recurse.
   */
  private observeSuccesses(roster: readonly ProxyHealth[]): void {
    for (const health of roster) {
      if (health.requests === 0) continue;
      const record = this.candidates.get(health.id);
      if (record === undefined) continue;
      record.everTried = true;
      if (health.successes > 0) record.everSucceeded = true;
    }
  }

  /**
   * Concurrent slots the pool can actually serve right now.
   *
   * `ProxyPoolStats.capacity` is already exactly this — the sum of earned
   * per-proxy capacity over entries that are neither retired nor cooling — so
   * this reads the pool's own number rather than keeping a second one. It is
   * what makes candidate quantity and usable capacity different quantities: a
   * proxy that has never succeeded contributes the probation floor, not the
   * ceiling, and a benched one contributes nothing at all.
   *
   * Counting `available` instead is what let 19 dead-but-unbenched proxies
   * report a pool at full strength while 817 candidates went unvalidated.
   */
  private usableCapacity(): number {
    const stats = this.roster.getStats();
    // `null` means no per-proxy limit is configured, so a single working proxy
    // can take unbounded work and slots stop being a meaningful unit. Falling
    // back to usable proxies keeps the deficit finite; the composition root
    // warns that a capacity target wants `PROXY_MAX_CONCURRENT` set.
    return stats.capacity ?? stats.available;
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
