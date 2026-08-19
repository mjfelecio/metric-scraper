import { describe, expect, it } from 'vitest';

import { type ProxyTarget } from '../../src/core/scraper/lease-ports.js';
import {
  type ProxyProbe,
  type ProxyProbeResult,
  type ProxySource,
  type ProxySourceFetchResult,
} from '../../src/core/scraper/proxy-source-ports.js';
import { InMemoryProxyPool } from '../../src/infrastructure/proxy/in-memory-proxy-pool.js';
import { parseProxyEntry } from '../../src/infrastructure/proxy/proxy-config.js';
import { ProxySourceManager } from '../../src/infrastructure/proxy/proxy-source-manager.js';

function targets(count: number, offset = 0): ProxyTarget[] {
  return Array.from({ length: count }, (_unused, index) => {
    const n = index + offset;
    return parseProxyEntry(`http://10.0.${Math.floor(n / 254)}.${(n % 254) + 1}:8080`);
  });
}

/** Fetches whatever it is currently told to, and counts calls. */
class FakeSource implements ProxySource {
  readonly name = 'fake';
  calls = 0;
  failNext = false;
  constructor(private list: ProxyTarget[]) {}

  setList(list: ProxyTarget[]): void {
    this.list = list;
  }

  fetch(): Promise<ProxySourceFetchResult> {
    this.calls += 1;
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('source unavailable'));
    }
    return Promise.resolve({
      targets: this.list,
      total: this.list.length,
      malformed: 0,
      duplicates: 0,
    });
  }
}

/** Passes ids in `passing`; records what it was asked and how concurrently. */
class FakeProbe implements ProxyProbe {
  readonly probed: string[] = [];
  inFlight = 0;
  maxInFlight = 0;
  constructor(private readonly passes: (target: ProxyTarget) => boolean) {}

  async probe(target: ProxyTarget): Promise<ProxyProbeResult> {
    this.probed.push(`${target.host}:${target.port}`);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await Promise.resolve();
    this.inFlight -= 1;
    const ok = this.passes(target);
    return { ok, durationMs: 1, reason: ok ? null : 'ECONNREFUSED' };
  }
}

/**
 * A manager over a real pool.
 *
 * `targetCapacity` is denominated in concurrent slots. A freshly admitted proxy
 * sits at the probation floor of one slot until it succeeds, so while nothing
 * has succeeded yet a target of N slots and a target of N proxies mean the same
 * thing — which is what makes these numbers readable either way.
 */
function build(options: {
  list: ProxyTarget[];
  passes?: ((target: ProxyTarget) => boolean) | undefined;
  targetCapacity?: number | undefined;
  minCapacity?: number | undefined;
  validateConcurrency?: number | undefined;
  configured?: string[] | undefined;
  maxConcurrentPerProxy?: number | undefined;
}) {
  const pool = new InMemoryProxyPool({
    targets: (options.configured ?? []).map(parseProxyEntry),
    maxConsecutiveFailures: 2,
    cooldownMs: 60_000,
    maxConcurrentPerProxy: options.maxConcurrentPerProxy ?? 4,
    acquireWaitMs: 0,
  });
  const source = new FakeSource(options.list);
  const probe = new FakeProbe(options.passes ?? (() => true));
  const manager = new ProxySourceManager({
    source,
    probe,
    roster: pool,
    targetCapacity: options.targetCapacity ?? 5,
    minCapacity: options.minCapacity ?? 1,
    validateConcurrency: options.validateConcurrency ?? 10,
    refreshIntervalMs: 0,
    replenishIntervalMs: 100_000,
  });
  return { pool, source, probe, manager };
}

describe('ProxySourceManager', () => {
  it('validates candidates and admits only the ones that pass', async () => {
    const { pool, probe, manager } = build({
      list: targets(10),
      passes: (target) => ['10.0.0.1', '10.0.0.2'].includes(target.host),
      targetCapacity: 5,
    });

    await manager.refreshOnce();
    await manager.replenishOnce();

    const admitted = pool.getStats().perProxy.map((proxy) => proxy.id);
    expect(admitted).toEqual(['http://10.0.0.1:8080', 'http://10.0.0.2:8080']);
    expect(probe.probed).toHaveLength(5);
  });

  it('probes only as many candidates as the capacity deficit calls for', async () => {
    // Handing a list of thousands to a probe loop at once would be a
    // self-inflicted network problem, and validating a proxy there is no room
    // for is work thrown away.
    const { probe, manager } = build({ list: targets(500), targetCapacity: 4 });

    await manager.refreshOnce();
    await manager.replenishOnce();

    expect(probe.probed).toHaveLength(4);
  });

  it('never runs more probes at once than its configured concurrency', async () => {
    const { probe, manager } = build({
      list: targets(50),
      targetCapacity: 40,
      validateConcurrency: 6,
    });

    await manager.refreshOnce();
    await manager.replenishOnce();

    expect(probe.maxInFlight).toBeLessThanOrEqual(6);
  });

  it('stops validating once the pool is at strength', async () => {
    const { probe, manager } = build({ list: targets(20), targetCapacity: 3 });

    await manager.refreshOnce();
    await manager.replenishOnce();
    const afterFirst = probe.probed.length;

    await manager.replenishOnce();

    expect(afterFirst).toBe(3);
    expect(probe.probed).toHaveLength(3);
  });

  it('never re-admits a proxy it already rejected, however often it is listed again', async () => {
    const { pool, source, probe, manager } = build({
      list: targets(3),
      passes: (target) => target.host === '10.0.0.3',
      targetCapacity: 3,
    });

    await manager.refreshOnce();
    await manager.replenishOnce();
    expect(pool.getStats().perProxy.map((proxy) => proxy.id)).toEqual(['http://10.0.0.3:8080']);

    // The same list comes back on every refresh. A rejected proxy reappearing
    // must not buy itself another probe, let alone another slot.
    source.setList(targets(3));
    await manager.refreshOnce();
    await manager.replenishOnce();

    expect(probe.probed).toHaveLength(3);
    expect(pool.getStats().perProxy).toHaveLength(1);
    expect(manager.getStats().rejected).toBe(2);
  });

  it('does not reset the health of a proxy that is listed again', async () => {
    const { pool, source, manager } = build({ list: targets(1), targetCapacity: 3 });

    await manager.refreshOnce();
    await manager.replenishOnce();

    const lease = (await pool.acquire())!;
    pool.reportFailure(lease, 'boom', 'network_error');
    pool.release(lease);
    expect(pool.getStats().perProxy[0]?.consecutiveFailures).toBe(1);

    source.setList(targets(1));
    await manager.refreshOnce();

    expect(pool.getStats().perProxy).toHaveLength(1);
    expect(pool.getStats().perProxy[0]?.consecutiveFailures).toBe(1);
  });

  it('evicts a proxy that never worked and replaces it from the candidate pool', async () => {
    const { pool, manager } = build({ list: targets(4), targetCapacity: 1 });

    await manager.refreshOnce();
    await manager.replenishOnce();
    const first = pool.getStats().perProxy[0]!.id;

    // Two failures with no success at all: it has burned its whole budget
    // without ever doing anything. Waiting out its cooldown buys nothing when
    // there are three more candidates waiting.
    const lease = (await pool.acquire())!;
    pool.reportFailure(lease, 'boom', 'network_error');
    pool.reportFailure(lease, 'boom', 'network_error');
    pool.release(lease);
    expect(pool.getStats().perProxy[0]?.state).toBe('cooling');

    await manager.replenishOnce();

    const ids = pool.getStats().perProxy.map((proxy) => proxy.id);
    expect(ids).not.toContain(first);
    expect(ids).toHaveLength(1);
  });

  it('keeps a proxy that has ever succeeded, letting it serve its cooldown', async () => {
    const { pool, manager } = build({ list: targets(4), targetCapacity: 1 });

    await manager.refreshOnce();
    await manager.replenishOnce();
    const first = pool.getStats().perProxy[0]!.id;

    const lease = (await pool.acquire())!;
    pool.reportSuccess(lease);
    pool.reportFailure(lease, 'boom', 'network_error');
    pool.reportFailure(lease, 'boom', 'network_error');
    pool.release(lease);

    await manager.replenishOnce();

    expect(pool.getStats().perProxy.map((proxy) => proxy.id)).toContain(first);
  });

  it('never evicts a statically configured proxy', async () => {
    const { pool, manager } = build({
      list: targets(4, 100),
      targetCapacity: 2,
      configured: ['http://config.example.net:9000'],
    });

    const lease = (await pool.acquire())!;
    pool.reportFailure(lease, 'boom', 'network_error');
    pool.reportFailure(lease, 'boom', 'network_error');
    pool.release(lease);

    await manager.refreshOnce();
    await manager.replenishOnce();

    // The static list has to keep behaving exactly as it did before the source
    // existed, cooldowns and all.
    expect(pool.getStats().perProxy.map((proxy) => proxy.id)).toContain(
      'http://config.example.net:9000',
    );
  });

  it('keeps running on the candidates it already holds when a refresh fails', async () => {
    const { pool, source, manager } = build({ list: targets(3), targetCapacity: 3 });

    await manager.refreshOnce();
    await manager.replenishOnce();
    const before = pool.getStats().perProxy.length;

    source.failNext = true;
    await manager.refreshOnce();

    expect(pool.getStats().perProxy).toHaveLength(before);
    expect(manager.getStats().refreshFailures).toBe(1);
    expect(manager.getStats().lastRefreshError).toMatch(/source unavailable/);
  });

  it('publishes its counters through the pool snapshot', async () => {
    const { pool, manager } = build({
      list: targets(6),
      passes: (target) => target.host !== '10.0.0.1',
      targetCapacity: 3,
    });

    await manager.refreshOnce();
    // One pass probes exactly the deficit; the shortfall left by a failed probe
    // is made up on the next tick rather than by looping here.
    await manager.replenishOnce();
    expect(pool.getStats().source?.admitted).toBe(2);
    await manager.replenishOnce();

    const source = pool.getStats().source;
    expect(source?.name).toBe('fake');
    expect(source?.admitted).toBe(3);
    expect(source?.probeFailures).toBe(1);
    expect(source?.targetCapacity).toBe(3);
  });

  it('keeps validating on start until the minimum healthy size is met', async () => {
    // Most candidates on a free list fail, and one pass probes only the
    // deficit — so a single round routinely leaves the floor unmet.
    const passing = new Set(['10.0.0.9', '10.0.0.10', '10.0.0.11']);
    const { pool, probe, manager } = build({
      list: targets(20),
      passes: (target) => passing.has(target.host),
      targetCapacity: 3,
      minCapacity: 3,
    });

    await manager.start();
    manager.stop();

    expect(pool.getStats().available).toBe(3);
    expect(probe.probed.length).toBeGreaterThan(3);
  });

  it('starts short rather than burning the whole list chasing an unreachable floor', async () => {
    const { pool, probe, manager } = build({
      list: targets(500),
      passes: () => false,
      targetCapacity: 5,
      minCapacity: 5,
    });

    await manager.start();
    manager.stop();

    expect(pool.getStats().available).toBe(0);
    expect(probe.probed.length).toBeLessThan(100);
  });
});

/**
 * What "we have enough proxies" is allowed to mean.
 *
 * The target is denominated in concurrent slots, because slots are what a run
 * spends. Counting proxy records instead is how 19 mostly-dead proxies reported
 * a pool at full strength while 817 candidates went unvalidated.
 */
describe('ProxySourceManager capacity accounting', () => {
  it('counts a proxy that has never succeeded as one slot, not as its ceiling', async () => {
    // Four entries against a target of sixteen slots. A proxy-denominated
    // target would read four-of-four and conclude there was nothing to do; the
    // pool can in fact serve four simultaneous requests, not sixteen.
    const { pool, probe, manager } = build({
      list: targets(40, 100),
      configured: [
        'http://c1.example.net:9000',
        'http://c2.example.net:9000',
        'http://c3.example.net:9000',
        'http://c4.example.net:9000',
      ],
      maxConcurrentPerProxy: 8,
      targetCapacity: 16,
    });

    expect(pool.getStats().capacity).toBe(4);

    await manager.refreshOnce();
    await manager.replenishOnce();

    expect(probe.probed).toHaveLength(12);
  });

  it('still finds a deficit when every entry is on probation with no successes', async () => {
    // The acceptance criterion from the issue: a roster of never-successful
    // entries is a roster of records, not of capacity.
    const { pool, probe, manager } = build({
      list: targets(40, 100),
      configured: ['http://c1.example.net:9000', 'http://c2.example.net:9000'],
      maxConcurrentPerProxy: 8,
      targetCapacity: 12,
    });

    for (let i = 0; i < 2; i += 1) {
      const lease = (await pool.acquire())!;
      pool.reportFailure(lease, 'boom', 'network_error');
      pool.release(lease);
    }
    expect(pool.getStats().perProxy.every((proxy) => proxy.state === 'probation')).toBe(true);
    expect(pool.getStats().available).toBe(2);

    await manager.refreshOnce();
    await manager.replenishOnce();

    expect(probe.probed).toHaveLength(10);
  });

  it('counts a benched proxy for nothing at all', async () => {
    const { pool, probe, manager } = build({
      list: targets(40, 100),
      configured: ['http://c1.example.net:9000'],
      maxConcurrentPerProxy: 8,
      targetCapacity: 4,
    });

    const lease = (await pool.acquire())!;
    pool.reportFailure(lease, 'boom', 'network_error');
    pool.reportFailure(lease, 'boom', 'network_error');
    pool.release(lease);
    expect(pool.getStats().perProxy[0]?.state).toBe('cooling');
    expect(pool.getStats().capacity).toBe(0);

    await manager.refreshOnce();
    await manager.replenishOnce();

    expect(probe.probed).toHaveLength(4);
  });

  it('does not let a candidate that failed validation count toward the target', async () => {
    const { pool, manager } = build({
      list: targets(10),
      passes: (target) => target.host === '10.0.0.1',
      targetCapacity: 3,
    });

    await manager.refreshOnce();
    await manager.replenishOnce();

    // Three probed, one admitted: candidate quantity is not usable quantity.
    expect(pool.getStats().capacity).toBe(1);
    expect(manager.getStats().probeFailures).toBe(2);
  });

  it('keeps working when the source cannot supply enough, without spinning', async () => {
    const { pool, probe, manager } = build({
      list: targets(2),
      passes: () => false,
      targetCapacity: 10,
    });

    await manager.refreshOnce();
    await manager.replenishOnce();
    await manager.replenishOnce();

    // The list is spent. A deficit it cannot close is not a reason to re-probe
    // what has already been rejected.
    expect(probe.probed).toHaveLength(2);
    expect(pool.getStats().capacity).toBe(0);
  });

  it('admits each proxy once however often the source lists it', async () => {
    const { pool, source, manager } = build({ list: targets(3), targetCapacity: 5 });

    for (let cycle = 0; cycle < 3; cycle += 1) {
      source.setList(targets(3));
      await manager.refreshOnce();
      await manager.replenishOnce();
    }

    const ids = pool.getStats().perProxy.map((proxy) => proxy.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });
});

/**
 * Eviction that cannot make the pool unrecoverable.
 *
 * Removing bad proxies is still the point; removing the last thing that could
 * ever serve a request is how a 3.5 s run produced 34 failures and no successes.
 */
describe('ProxySourceManager eviction floor', () => {
  it('admits the replacement before giving up the entry it replaces', async () => {
    // Built inline rather than through `build`, so the probe can read the
    // roster it is being validated against while the tick is still running.
    const pool = new InMemoryProxyPool({
      targets: [],
      maxConsecutiveFailures: 2,
      cooldownMs: 60_000,
      maxConcurrentPerProxy: 4,
      acquireWaitMs: 0,
    });
    const rosterDuringProbe: number[] = [];
    const manager = new ProxySourceManager({
      source: new FakeSource(targets(2)),
      probe: new FakeProbe(() => {
        rosterDuringProbe.push(pool.getStats().configured);
        return true;
      }),
      roster: pool,
      targetCapacity: 1,
      minCapacity: 1,
      validateConcurrency: 10,
      refreshIntervalMs: 0,
      replenishIntervalMs: 100_000,
    });

    await manager.refreshOnce();
    await manager.replenishOnce();
    const first = pool.getStats().perProxy[0]!.id;

    const lease = (await pool.acquire())!;
    pool.reportFailure(lease, 'boom', 'network_error');
    pool.reportFailure(lease, 'boom', 'network_error');
    pool.release(lease);

    await manager.replenishOnce();

    // The hopeless entry was still on the roster while its replacement was being
    // validated: a swap, not a drop followed by a hopeful refill.
    expect(rosterDuringProbe).toEqual([0, 1]);
    const ids = pool.getStats().perProxy.map((proxy) => proxy.id);
    expect(ids).toHaveLength(1);
    expect(ids).not.toContain(first);
  });

  it('keeps benched proxies rather than reaping the roster below its floor', async () => {
    const { pool, manager } = build({ list: targets(2), targetCapacity: 2, minCapacity: 2 });

    await manager.refreshOnce();
    await manager.replenishOnce();
    expect(pool.getStats().perProxy).toHaveLength(2);

    for (const entry of [...pool.getStats().perProxy]) {
      const lease = (await pool.acquire())!;
      pool.reportFailure(lease, 'boom', 'network_error');
      pool.reportFailure(lease, 'boom', 'network_error');
      pool.release(lease);
      expect(entry.id).toBeDefined();
    }
    expect(pool.getStats().cooling).toBe(2);

    // The candidate list is spent, so these two are the only things that will
    // ever serve a request again. Evicting them would be an outage nothing can
    // recover from; keeping them costs a cooldown.
    await manager.replenishOnce();
    await manager.replenishOnce();

    expect(pool.getStats().perProxy).toHaveLength(2);
    expect(pool.getStats().cooling).toBe(2);
  });

  it('evicts a retired proxy even when that empties the roster', async () => {
    const { pool, manager } = build({ list: targets(1), targetCapacity: 1, minCapacity: 2 });

    await manager.refreshOnce();
    await manager.replenishOnce();
    expect(pool.getStats().perProxy).toHaveLength(1);

    for (let i = 0; i < 2; i += 1) {
      const lease = (await pool.acquire())!;
      pool.reportUnsuitable(lease, 'HTTP 451');
      pool.release(lease);
    }
    expect(pool.getStats().retired).toBe(1);

    await manager.replenishOnce();

    // No cooldown returns an exit node to another jurisdiction, so the floor has
    // nothing to protect here — keeping it would only make the pool look stocked.
    expect(pool.getStats().perProxy).toHaveLength(0);
    expect(manager.getStats().rejected).toBe(1);
  });

  it('leaves a proxy alone while a job still holds a lease on it', async () => {
    const { pool, manager } = build({ list: targets(4), targetCapacity: 2, minCapacity: 1 });

    await manager.refreshOnce();
    await manager.replenishOnce();

    // Benched with the lease still out: the job owes an outcome against this
    // proxy, and dropping the entry underneath it would discard that outcome.
    const held = (await pool.acquire())!;
    pool.reportFailure(held, 'boom', 'network_error');
    pool.reportFailure(held, 'boom', 'network_error');

    await manager.replenishOnce();
    expect(pool.getStats().perProxy.map((proxy) => proxy.id)).toContain(held.id);

    pool.release(held);
    await manager.replenishOnce();

    expect(pool.getStats().perProxy.map((proxy) => proxy.id)).not.toContain(held.id);
  });

  it('leaves a proxy that ever succeeded to serve its cooldown', async () => {
    const { pool, manager } = build({ list: targets(4), targetCapacity: 2, minCapacity: 1 });

    await manager.refreshOnce();
    await manager.replenishOnce();

    const lease = (await pool.acquire())!;
    pool.reportSuccess(lease);
    pool.reportFailure(lease, 'boom', 'network_error');
    pool.reportFailure(lease, 'boom', 'network_error');
    pool.release(lease);

    await manager.replenishOnce();

    expect(pool.getStats().perProxy.map((proxy) => proxy.id)).toContain(lease.id);
  });
});

describe('ProxySourceManager and the rotation model', () => {
  it('gives a replenished proxy the exploration and the earned capacity of any other', async () => {
    const { pool, manager } = build({
      list: targets(1),
      configured: ['http://config.example.net:9000'],
      maxConcurrentPerProxy: 8,
      // Above what one proven proxy can earn on its own, so there is still a
      // deficit for the candidate to fill once the config proxy is established.
      targetCapacity: 10,
    });

    // Establish the config proxy first, so the new arrival is competing against
    // a proven one rather than being the only thing available.
    for (let i = 0; i < 3; i += 1) {
      const lease = (await pool.acquire())!;
      pool.reportSuccess(lease);
      pool.release(lease);
    }

    await manager.refreshOnce();
    await manager.replenishOnce();

    const fresh = pool.getStats().perProxy.find((proxy) => proxy.source === 'fake')!;
    // Admission does not buy capacity: it starts at the probation floor like
    // every other proxy that has never worked.
    expect(fresh.capacity).toBe(1);

    const served = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const lease = (await pool.acquire())!;
      served.add(lease.id);
      pool.reportSuccess(lease);
      pool.release(lease);
    }

    // The reserved share reaches it within one exploration period, and the
    // success it earns there doubles its slots exactly as for a config proxy.
    expect(served).toContain(fresh.id);
    const after = pool.getStats().perProxy.find((proxy) => proxy.id === fresh.id)!;
    expect(after.capacity).toBe(2);
  });
});
