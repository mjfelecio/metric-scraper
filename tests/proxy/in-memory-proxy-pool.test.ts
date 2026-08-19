import { describe, expect, it } from 'vitest';

import { ScrapeError } from '../../src/core/models/errors.js';
import { type ProxyLease, type ProxyTarget } from '../../src/core/scraper/lease-ports.js';
import { type ProxyEvent } from '../../src/core/scraper/pool-ports.js';
import { type ProxySourceStats } from '../../src/core/scraper/proxy-source-ports.js';
import { InMemoryProxyPool } from '../../src/infrastructure/proxy/in-memory-proxy-pool.js';

function target(name: string): ProxyTarget {
  return {
    protocol: 'http',
    host: `${name}.example.net`,
    port: 8000,
    username: null,
    password: null,
    url: `http://${name}.example.net:8000`,
  };
}

function pool(options: {
  names: string[];
  targets?: ProxyTarget[];
  maxConcurrentPerProxy?: number;
  cooldownMs?: number;
  maxConsecutiveFailures?: number;
  probationConcurrency?: number;
  explorationPeriod?: number;
  requireProxy?: boolean;
  acquireWaitMs?: number;
}): {
  pool: InMemoryProxyPool;
  advance: (ms: number) => void;
  /** Advances the clock and runs every acquire-wait timer that has come due. */
  advanceTimers: (ms: number) => Promise<void>;
  events: ProxyEvent[];
  clock: () => number;
} {
  let current = 0;
  const events: ProxyEvent[] = [];
  // Acquire-wait timers are driven by the same clock the pool reads, so a test
  // never has to sit through a real one to observe what waiting does.
  let timerSequence = 0;
  const timers = new Map<number, { dueAt: number; fire: () => void }>();
  const instance = new InMemoryProxyPool({
    targets: options.targets ?? options.names.map(target),
    now: () => current,
    onEvent: (event) => events.push(event),
    setTimer: (fire, ms) => {
      const id = ++timerSequence;
      timers.set(id, { dueAt: current + ms, fire });
      return () => timers.delete(id);
    },
    ...(options.maxConcurrentPerProxy === undefined
      ? {}
      : { maxConcurrentPerProxy: options.maxConcurrentPerProxy }),
    ...(options.cooldownMs === undefined ? {} : { cooldownMs: options.cooldownMs }),
    ...(options.maxConsecutiveFailures === undefined
      ? {}
      : { maxConsecutiveFailures: options.maxConsecutiveFailures }),
    ...(options.probationConcurrency === undefined
      ? {}
      : { probationConcurrency: options.probationConcurrency }),
    ...(options.explorationPeriod === undefined
      ? {}
      : { explorationPeriod: options.explorationPeriod }),
    ...(options.requireProxy === undefined ? {} : { requireProxy: options.requireProxy }),
    ...(options.acquireWaitMs === undefined ? {} : { acquireWaitMs: options.acquireWaitMs }),
  });
  return {
    pool: instance,
    advance: (ms: number) => {
      current += ms;
    },
    advanceTimers: async (ms: number) => {
      current += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.dueAt > current) continue;
        timers.delete(id);
        timer.fire();
      }
      await flush();
    },
    events,
    clock: () => current,
  };
}

/**
 * Walks every proxy through `rounds` successes.
 *
 * Capacity is earned a doubling at a time, so `rounds` is how far up the ramp
 * the proxies start: one round is two slots, two rounds four, three rounds
 * eight. Tests about the steady state say how proven they mean.
 *
 * Each round holds every lease until all `count` proxies have one, because a
 * proxy's earned capacity only grows once per success — releasing in between
 * would hand the whole round to whichever proxy succeeded first.
 */
async function prove(instance: InMemoryProxyPool, count: number, rounds = 1): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    const leases = [];
    for (let i = 0; i < count; i += 1) {
      leases.push((await instance.acquire())!);
    }
    for (const lease of leases) {
      instance.reportSuccess(lease);
      instance.release(lease);
    }
  }
}

/** Every proxy's earned capacity, keyed by the name it was built from. */
function capacities(instance: InMemoryProxyPool): Record<string, number | null> {
  return Object.fromEntries(
    instance
      .getStats()
      .perProxy.map((entry) => [entry.id.split('//')[1]!.split('.')[0]!, entry.capacity]),
  );
}

/**
 * A source snapshot, so a test can say "more capacity is on its way".
 *
 * `candidates` and `validating` are the only two fields the pool reads: they
 * are what separates a roster that can be refilled from one that cannot.
 */
function sourceStats(overrides: Partial<ProxySourceStats> = {}): ProxySourceStats {
  return {
    name: 'fake',
    candidates: 0,
    validating: 0,
    admitted: 0,
    rejected: 0,
    fetched: 0,
    malformed: 0,
    duplicates: 0,
    refreshes: 1,
    refreshFailures: 0,
    lastRefreshAt: 0,
    lastRefreshError: null,
    probeSuccesses: 0,
    probeFailures: 0,
    targetCapacity: 10,
    ...overrides,
  };
}

/**
 * Lets every pending continuation run.
 *
 * A woken waiter travels several microtask hops — resolve, re-check the pool,
 * resolve `acquire`, then the caller's own `then` — so counting `await`s is a
 * guess. A macrotask boundary is not.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Takes leases until the pool blocks, so a test can measure real capacity.
 *
 * The probe that finds the pool full is aborted rather than abandoned: an
 * abandoned `acquire` stays parked as a waiter and would take the next released
 * slot out from under whatever the test does next.
 */
async function drain(instance: InMemoryProxyPool, ceiling = 32): Promise<ProxyLease[]> {
  const held: ProxyLease[] = [];
  for (;;) {
    const probe = new AbortController();
    let settled = false;
    const attempt = instance.acquire(probe.signal).then(
      (lease) => {
        settled = true;
        return lease;
      },
      () => null,
    );

    await flush();
    if (!settled) {
      probe.abort();
      await attempt;
      break;
    }

    const lease = await attempt;
    if (lease === null) break;
    held.push(lease);
    if (held.length >= ceiling) break;
  }
  return held;
}

describe('InMemoryProxyPool rotation', () => {
  it('spreads leases across proxies least-recently-used first', async () => {
    const { pool: proxies } = pool({ names: ['a', 'b', 'c'] });

    const seen: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const lease = await proxies.acquire();
      expect(lease).not.toBeNull();
      seen.push(lease!.id);
      proxies.release(lease!);
    }

    // Every proxy pulls equal weight rather than one absorbing the whole batch.
    expect(new Set(seen).size).toBe(3);
    expect(seen.filter((id) => id.includes('a.'))).toHaveLength(2);
  });

  it('returns null when no proxies are configured, meaning go direct', async () => {
    const { pool: proxies } = pool({ names: [] });
    await expect(proxies.acquire()).resolves.toBeNull();
  });
});

describe('InMemoryProxyPool capacity', () => {
  it('lets several proxies be held at the same time', async () => {
    const { pool: proxies } = pool({ names: ['a', 'b', 'c'], maxConcurrentPerProxy: 1 });

    const first = await proxies.acquire();
    const second = await proxies.acquire();
    const third = await proxies.acquire();

    expect(new Set([first!.id, second!.id, third!.id]).size).toBe(3);
    expect(proxies.getStats().inUse).toBe(3);
  });

  it('caps how many jobs share one proxy, and makes the extra one wait', async () => {
    const { pool: proxies } = pool({ names: ['a'], maxConcurrentPerProxy: 1 });

    const held = await proxies.acquire();
    let acquired = false;
    const waiting = proxies.acquire().then((lease) => {
      acquired = true;
      return lease;
    });

    // Nothing is free, so the second caller must not be handed the same slot.
    await Promise.resolve();
    expect(acquired).toBe(false);

    proxies.release(held!);
    const second = await waiting;
    expect(acquired).toBe(true);
    expect(second!.id).toBe(held!.id);
  });

  it('increases total capacity when a proxy is added', async () => {
    const small = pool({ names: ['a'], maxConcurrentPerProxy: 2 });
    const large = pool({ names: ['a', 'b'], maxConcurrentPerProxy: 2 });
    await prove(small.pool, 1);
    await prove(large.pool, 2);

    const capacityOf = async (p: InMemoryProxyPool): Promise<number> => {
      let held = 0;
      for (;;) {
        let settled = false;
        const attempt = p.acquire().then((lease) => {
          settled = true;
          return lease;
        });
        await Promise.resolve();
        await Promise.resolve();
        if (!settled) break;
        await attempt;
        held += 1;
        if (held > 10) break;
      }
      return held;
    };

    // This is the property the original investigation expected and did not get:
    // more proxies must mean more simultaneous capacity.
    expect(await capacityOf(small.pool)).toBe(2);
    expect(await capacityOf(large.pool)).toBe(4);
  });

  it('shares a proven proxy without limit when no per-proxy cap is set', async () => {
    const { pool: proxies } = pool({ names: ['a'] });
    await prove(proxies, 1);

    const first = await proxies.acquire();
    const second = await proxies.acquire();

    expect(first!.id).toBe(second!.id);
  });

  it('hands an unproven proxy one job at a time even with no cap set', async () => {
    const { pool: proxies } = pool({ names: ['a'] });

    const held = await proxies.acquire();
    let acquired = false;
    void proxies.acquire().then((lease) => {
      acquired = true;
      return lease;
    });

    // Health is only checked at acquire time, so piling jobs onto a proxy that
    // has never returned an outcome is exactly how a dead IP absorbed 30
    // requests before its third failure was recorded.
    await Promise.resolve();
    await Promise.resolve();
    expect(acquired).toBe(false);

    proxies.reportSuccess(held!);
    proxies.release(held!);
  });

  it('holds a repeatedly-failing proxy to one job while a healthy one stays open', async () => {
    const { pool: proxies } = pool({ names: ['a', 'b'], maxConcurrentPerProxy: 4 });
    // Two rounds, so both proxies are at the full four slots before anything
    // goes wrong: this is about what failure takes away, not about the ramp.
    await prove(proxies, 2, 2);

    // Two failures walk 'a' from 4 slots to 2 to 1 — the floor, but reached by
    // halving rather than by the last outcome latching it there. 'b' is
    // untouched, so the pool has 1 + 4 slots left.
    const first = (await proxies.acquire())!;
    const suspect = first.id;
    proxies.reportFailure(first, 'timeout');
    proxies.release(first);
    proxies.reportFailure(first, 'timeout');

    const held = await drain(proxies);
    expect(held.filter((lease) => lease.id === suspect)).toHaveLength(1);
    expect(held.filter((lease) => lease.id !== suspect)).toHaveLength(4);
  });

  it('stops handing work to a dead proxy long before the batch is done', async () => {
    const { pool: proxies } = pool({
      names: ['dead', 'good'],
      maxConcurrentPerProxy: 8,
      maxConsecutiveFailures: 3,
    });

    // Everything through 'dead' fails; 'good' always works. 20 jobs, run the
    // way the runner runs them: acquire, report, release.
    for (let i = 0; i < 20; i += 1) {
      const lease = await proxies.acquire();
      if (lease!.id.includes('dead.')) {
        proxies.reportFailure(lease!, 'timeout');
      } else {
        proxies.reportSuccess(lease!);
      }
      proxies.release(lease!);
    }

    const stats = proxies.getStats();
    const dead = stats.perProxy.find((entry) => entry.id.includes('dead.'));
    const good = stats.perProxy.find((entry) => entry.id.includes('good.'));
    // Bounded by the failure threshold at worst, and in practice by the first
    // failure: a proxy that has just failed is behind every working one.
    expect(dead?.requests).toBeLessThanOrEqual(3);
    expect(good?.requests).toBeGreaterThanOrEqual(17);
  });
});

describe('InMemoryProxyPool earned capacity', () => {
  it('ramps a proxy up a doubling at a time and stops at the configured ceiling', async () => {
    const { pool: proxies } = pool({ names: ['a'], maxConcurrentPerProxy: 8 });

    const seen: (number | null)[] = [capacities(proxies).a!];
    for (let i = 0; i < 5; i += 1) {
      const lease = (await proxies.acquire())!;
      proxies.reportSuccess(lease);
      proxies.release(lease);
      seen.push(capacities(proxies).a!);
    }

    // Three successes to full concurrency: fast enough to matter inside a short
    // run, slow enough that one lucky response does not open eight slots.
    expect(seen).toEqual([1, 2, 4, 8, 8, 8]);
  });

  it('halves capacity on a failure instead of collapsing it to the floor', async () => {
    const { pool: proxies } = pool({ names: ['a'], maxConcurrentPerProxy: 8 });
    await prove(proxies, 1, 3);
    expect(capacities(proxies).a).toBe(8);

    const lease = (await proxies.acquire())!;
    proxies.reportFailure(lease, 'timeout');
    proxies.release(lease);

    // The whole of #20: one failure used to latch this proxy at 1 until its
    // next success, so a pool of intermittently-failing proxies never held more
    // than one job each however good their record.
    expect(capacities(proxies).a).toBe(4);
    const held = await drain(proxies);
    expect(held).toHaveLength(4);
  });

  it('lets an 80%-success proxy keep several slots while carrying a recent failure', async () => {
    const { pool: proxies } = pool({
      names: ['a'],
      maxConcurrentPerProxy: 8,
      maxConsecutiveFailures: 3,
    });

    // Eight successes and two failures over ten requests, failures last.
    for (let i = 0; i < 10; i += 1) {
      const lease = (await proxies.acquire())!;
      if (i === 4 || i === 9) proxies.reportFailure(lease, 'timeout');
      else proxies.reportSuccess(lease);
      proxies.release(lease);
    }

    const entry = proxies.getStats().perProxy[0]!;
    expect(entry.successes).toBe(8);
    expect(entry.consecutiveFailures).toBe(1);
    expect(entry.state).toBe('probation');
    // Reduced, not revoked: an unresolved failure costs a proxy half its
    // concurrency, and its record buys the other half.
    expect(entry.capacity).toBe(4);
  });

  it('never lets a proxy that has not succeeded past one job at a time', async () => {
    const { pool: proxies } = pool({
      names: ['a'],
      maxConcurrentPerProxy: 8,
      maxConsecutiveFailures: 100,
    });

    for (let i = 0; i < 10; i += 1) {
      const lease = (await proxies.acquire())!;
      // A definitive answer about a URL counts as a healthy use of a proxy, but
      // nothing here is one: this proxy has never carried a request home.
      proxies.reportFailure(lease, 'ECONNRESET');
      proxies.release(lease);
      expect(capacities(proxies).a).toBe(1);
    }

    expect(await drain(proxies)).toHaveLength(1);
  });

  it('walks capacity back down a step at a time and brings it back at the floor', async () => {
    const { pool: proxies, advance } = pool({
      names: ['a'],
      maxConcurrentPerProxy: 8,
      maxConsecutiveFailures: 3,
      cooldownMs: 60_000,
    });
    await prove(proxies, 1, 3);

    const lease = (await proxies.acquire())!;
    proxies.release(lease);
    const walk: (number | null)[] = [capacities(proxies).a!];
    for (let i = 0; i < 3; i += 1) {
      proxies.reportFailure(lease, 'timeout');
      walk.push(capacities(proxies).a!);
    }
    expect(walk).toEqual([8, 4, 2, 1]);
    expect(proxies.getStats().perProxy[0]?.state).toBe('cooling');

    advance(60_000);
    // A served cooldown restores the failure budget, but not the concurrency:
    // the proxy comes back having to earn its slots again rather than being
    // handed eight the moment the clock says it may try.
    expect(proxies.getStats().perProxy[0]?.consecutiveFailures).toBe(0);
    expect(capacities(proxies).a).toBe(1);
  });

  it('admits waiters exactly up to capacity, one per release', async () => {
    const { pool: proxies } = pool({ names: ['a'], maxConcurrentPerProxy: 4 });
    await prove(proxies, 1, 2);
    expect(capacities(proxies).a).toBe(4);

    const held = await drain(proxies);
    expect(held).toHaveLength(4);

    // Two more callers arrive with nothing free. Both must park.
    const admitted: string[] = [];
    const waiters = [proxies.acquire(), proxies.acquire()].map(async (pending) => {
      admitted.push((await pending)!.id);
    });
    await flush();
    expect(admitted).toHaveLength(0);

    proxies.release(held[0]!);
    await flush();
    // A broadcast wake-up cannot lose a waiter, and cannot over-admit either:
    // the second re-checks, finds the pool full again, and parks.
    expect(admitted).toHaveLength(1);

    proxies.release(held[1]!);
    await Promise.all(waiters);
    expect(admitted).toHaveLength(2);
  });

  it('keeps the ramp out of the way when no per-proxy limit is configured', async () => {
    const { pool: proxies } = pool({ names: ['a', 'b'] });
    await prove(proxies, 2);

    const failed = (await proxies.acquire())!;
    proxies.reportFailure(failed, 'timeout');
    proxies.release(failed);

    // With no budget to ration there is nothing to ramp, so a failure no longer
    // costs a working proxy its concurrency — but a proxy that has never worked
    // is still handed one job at a time, which is the bound that earns its keep.
    for (const entry of proxies.getStats().perProxy) expect(entry.capacity).toBeNull();
    expect(proxies.add([target('c')], 'fake')).toBe(1);
    expect(capacities(proxies).c).toBe(1);
  });
});

/**
 * Runs `count` leases the way the runner does — acquire, report, release — and
 * returns which proxy served each one.
 */
async function runLeases(
  instance: InMemoryProxyPool,
  count: number,
  succeeds: (id: string) => boolean,
): Promise<string[]> {
  const served: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const lease = (await instance.acquire())!;
    served.push(lease.id.split('//')[1]!.split('.')[0]!);
    if (succeeds(lease.id)) instance.reportSuccess(lease);
    else instance.reportFailure(lease, 'timeout');
    instance.release(lease);
  }
  return served;
}

function tally(served: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const name of served) counts[name] = (counts[name] ?? 0) + 1;
  return counts;
}

describe('InMemoryProxyPool exploration', () => {
  it('gives a newly admitted proxy traffic while a proven one still has room', async () => {
    const { pool: proxies } = pool({
      names: ['proven'],
      maxConcurrentPerProxy: 8,
      explorationPeriod: 5,
    });
    await prove(proxies, 1, 3);
    expect(capacities(proxies).proven).toBe(8);

    proxies.add([target('fresh')], 'proxyscrape');
    const served = await runLeases(proxies, 5, () => true);

    // The whole of #21: the proven proxy has seven free slots, so under strict
    // tiering the new one would never be selected at all and could never earn
    // the success it needs to be preferred.
    expect(served).toContain('fresh');
    expect(served.indexOf('fresh')).toBeLessThan(5);
  });

  it('spends about one lease in five on unproven proxies and no more', async () => {
    const { pool: proxies } = pool({
      names: ['proven', 'u1', 'u2', 'u3'],
      maxConcurrentPerProxy: 8,
      maxConsecutiveFailures: 1_000,
      explorationPeriod: 5,
    });

    // Only 'proven' ever works. The others stay unproven for the whole run, so
    // every lease they get is a lease exploration deliberately spent.
    const served = await runLeases(proxies, 100, (id) => id.includes('proven.'));
    const explored = served.filter((name) => name !== 'proven').length;

    // A hard, predictable ceiling on requests spent on unknown proxies — which
    // is the reason for a fixed share rather than weighted-random selection.
    expect(explored).toBeGreaterThan(15);
    expect(explored).toBeLessThanOrEqual(25);
  });

  it('rotates the exploration budget rather than re-testing one proxy', async () => {
    const { pool: proxies } = pool({
      names: ['proven', 'u1', 'u2', 'u3'],
      maxConcurrentPerProxy: 8,
      maxConsecutiveFailures: 1_000,
      explorationPeriod: 5,
    });

    const served = await runLeases(proxies, 100, (id) => id.includes('proven.'));
    const counts = tally(served);

    // Least-tried-first, so the budget is shared out instead of being burnt on
    // whichever unproven proxy happens to sort first.
    for (const name of ['u1', 'u2', 'u3']) expect(counts[name]).toBeGreaterThan(4);
  });

  it('bounds what exploration can waste on a proxy that never works', async () => {
    const { pool: proxies } = pool({
      names: ['proven', 'dead'],
      maxConcurrentPerProxy: 8,
      maxConsecutiveFailures: 3,
      cooldownMs: 60_000,
      explorationPeriod: 5,
    });

    const served = await runLeases(proxies, 100, (id) => id.includes('proven.'));

    // Exploration is self-limiting: a proxy that keeps failing hits the failure
    // threshold and leaves the eligible set, so the worst case is exactly the
    // budget the pool already spends discovering any bad proxy.
    expect(tally(served).dead).toBe(3);
    expect(proxies.getStats().perProxy.find((e) => e.label === 'p2')?.state).toBe('cooling');
  });

  it('keeps selection deterministic rather than reaching for randomness', async () => {
    const outcome = (id: string): boolean => !id.includes('u2.');
    const first = await runLeases(pool({ names: ['a', 'u1', 'u2'] }).pool, 60, outcome);
    const second = await runLeases(pool({ names: ['a', 'u1', 'u2'] }).pool, 60, outcome);

    // Same pool, same outcomes, same lease sequence. Random selection would
    // spread load too, but nothing about it could be reasoned about or tested.
    expect(first).toEqual(second);
  });

  it('keeps lease counts within a bounded spread across a working pool', async () => {
    const names = Array.from({ length: 10 }, (_, index) => `p${index}`);
    const { pool: proxies } = pool({ names, maxConcurrentPerProxy: 8, explorationPeriod: 5 });

    const served = await runLeases(proxies, 200, () => true);
    const counts = names.map((name) => tally(served)[name] ?? 0);
    counts.sort((left, right) => left - right);
    const median = counts[Math.floor(counts.length / 2)]!;

    // The measured failure in #21 was one proxy taking 19 leases against a
    // median of 3 while nineteen others idled.
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts.at(-1)!).toBeLessThanOrEqual(median * 3);
  });

  it('falls back to strict preference when exploration is switched off', async () => {
    const { pool: proxies } = pool({
      names: ['proven'],
      maxConcurrentPerProxy: 8,
      explorationPeriod: 0,
    });
    await prove(proxies, 1, 3);
    proxies.add([target('fresh')], 'proxyscrape');

    const served = await runLeases(proxies, 10, () => true);
    // The escape hatch: with a budget of zero, an unproven proxy is served only
    // when the established tier has nothing left to give.
    expect(served.every((name) => name === 'proven')).toBe(true);
  });

  it('lets a proxy that has worked before compete after a failure', async () => {
    const { pool: proxies } = pool({ names: ['a', 'b'], maxConcurrentPerProxy: 4 });
    await prove(proxies, 2, 2);

    const failed = (await proxies.acquire())!;
    proxies.reportFailure(failed, 'timeout');
    proxies.release(failed);

    const served = await runLeases(proxies, 6, () => true);
    // It goes to the back of the queue, not out of it. Treating one failure as
    // a demotion to the unproven tier is what kept the proven set at two
    // members and concentrated every failure on them.
    expect(new Set(served).size).toBe(2);
  });
});

describe('InMemoryProxyPool health', () => {
  it('benches a proxy after repeated failures and restores it after the cooldown', async () => {
    const { pool: proxies, advance } = pool({
      names: ['a', 'b'],
      cooldownMs: 60_000,
      maxConsecutiveFailures: 2,
    });

    const lease = await proxies.acquire();
    proxies.reportFailure(lease!, 'timeout');
    proxies.release(lease!);
    const again = await proxies.acquire();
    // Force both failures onto the same proxy.
    const same = again!.id === lease!.id ? again! : lease!;
    proxies.reportFailure(same, 'timeout');
    proxies.release(again!);

    const benched = proxies.getStats().perProxy.filter((p) => p.cooldownUntil !== null);
    expect(benched).toHaveLength(1);

    advance(60_001);
    expect(proxies.getStats().available).toBe(2);
  });

  it('fails loudly when every proxy is cooling down rather than going direct', async () => {
    // With no wait budget this is the contract exactly as it was before waiting
    // existed: nothing usable, so the attempt fails at once.
    const { pool: proxies } = pool({
      names: ['a'],
      maxConsecutiveFailures: 1,
      acquireWaitMs: 0,
    });

    const lease = await proxies.acquire();
    proxies.markBlocked(lease!, 'blocked');
    proxies.release(lease!);

    // Silently falling back to a direct connection would expose the origin IP.
    await expect(proxies.acquire()).rejects.toThrow(ScrapeError);
    await expect(proxies.acquire()).rejects.toThrow(/blocked or cooling down/);
  });

  it('records a success during a cooldown without cutting the cooldown short', async () => {
    const { pool: proxies, advance } = pool({
      names: ['a'],
      maxConsecutiveFailures: 1,
      cooldownMs: 60_000,
    });

    const lease = await proxies.acquire();
    proxies.reportFailure(lease!, 'timeout');
    expect(proxies.getStats().perProxy[0]?.cooldownUntil).not.toBeNull();

    // A job leased before the bench is still in flight, and reports back after
    // it. Crediting the success is right; letting it un-bench the proxy is not
    // — that turned a 60 s cooldown into a few hundred milliseconds and
    // cancelled detected blocks outright.
    proxies.reportSuccess(lease!);
    expect(proxies.getStats().perProxy[0]?.successes).toBe(1);
    expect(proxies.getStats().perProxy[0]?.consecutiveFailures).toBe(0);
    expect(proxies.getStats().perProxy[0]?.cooldownUntil).not.toBeNull();
    expect(proxies.getStats().perProxy[0]?.state).toBe('cooling');

    advance(60_000);
    expect(proxies.getStats().perProxy[0]?.cooldownUntil).toBeNull();
  });

  it('gives a proxy a fresh failure budget once its cooldown is served', async () => {
    const { pool: proxies, advance } = pool({
      names: ['a'],
      maxConsecutiveFailures: 2,
      cooldownMs: 60_000,
    });

    const lease = (await proxies.acquire())!;
    proxies.reportFailure(lease, 'timeout');
    proxies.reportFailure(lease, 'timeout');
    expect(proxies.getStats().perProxy[0]?.state).toBe('cooling');

    advance(60_000);
    // Carrying the counter over left the proxy one failure from a threshold it
    // had just served in full — a one-strike policy wearing a three-strike name.
    expect(proxies.getStats().perProxy[0]?.consecutiveFailures).toBe(0);

    proxies.reportFailure(lease, 'timeout');
    expect(proxies.getStats().perProxy[0]?.state).not.toBe('cooling');
  });

  it('retires a proxy whose exit node keeps coming back unsuitable', async () => {
    const { pool: proxies, advance } = pool({
      names: ['a'],
      maxConsecutiveFailures: 3,
      cooldownMs: 60_000,
    });

    for (let i = 0; i < 3; i += 1) {
      const lease = await proxies.acquire();
      proxies.reportUnsuitable(lease!, 'HTTP 451');
      proxies.release(lease!);
    }

    const entry = proxies.getStats().perProxy[0];
    expect(entry?.unsuitable).toBe(3);
    expect(entry?.retired).toBe(true);

    // Unlike a cooldown this does not heal with time: no jurisdiction changes
    // because 60 seconds passed, so the proxy stays gone.
    advance(600_000);
    expect(proxies.getStats().available).toBe(0);
    expect(proxies.getStats().retired).toBe(1);
    await expect(proxies.acquire()).rejects.toThrow(/blocked or cooling down/);
  });

  it('prefers a proven proxy over one that just failed, without benching it', async () => {
    const { pool: proxies } = pool({ names: ['a', 'b'], maxConcurrentPerProxy: 2 });
    await prove(proxies, 2);

    const failed = (await proxies.acquire())!;
    proxies.reportFailure(failed, 'timeout');
    proxies.release(failed);

    // One failure is not a cooldown, but it does move the proxy to the back of
    // the queue: work goes to the one still known to be working.
    const next = (await proxies.acquire())!;
    expect(next.id).not.toBe(failed.id);
    proxies.release(next);
    expect(proxies.getStats().available).toBe(2);
  });

  it('keeps an occasionally-unsuitable proxy once it succeeds in between', async () => {
    const { pool: proxies } = pool({ names: ['a'], maxConsecutiveFailures: 3 });

    for (let i = 0; i < 5; i += 1) {
      const unsuitable = await proxies.acquire();
      proxies.reportUnsuitable(unsuitable!, 'HTTP 451');
      proxies.release(unsuitable!);

      const okay = await proxies.acquire();
      proxies.reportSuccess(okay!);
      proxies.release(okay!);
    }

    // One restricted URL is not a jurisdiction block, and the proxy is still
    // fetching everything else.
    const entry = proxies.getStats().perProxy[0];
    expect(entry?.retired).toBe(false);
    expect(entry?.unsuitable).toBe(5);
  });

  it('does not strand a waiting caller when the run is cancelled', async () => {
    const { pool: proxies } = pool({ names: ['a'], maxConcurrentPerProxy: 1 });
    const controller = new AbortController();

    const held = await proxies.acquire();
    const waiting = proxies.acquire(controller.signal);

    controller.abort();
    // The waiter wakes and re-checks, then reports the abort rather than hanging.
    await expect(waiting).rejects.toThrow();
    proxies.release(held!);
  });
});

/**
 * `acquire` when there is nothing to hand out.
 *
 * The three cases below look identical from inside the pool and are completely
 * different to a run: capacity that is seconds away, capacity that is minutes
 * away, and capacity that is never coming. Answering all three the same way is
 * what turned a burst of evictions into a run with zero successes.
 */
describe('InMemoryProxyPool acquisition under exhaustion', () => {
  it('waits out a cooldown that expires inside the budget instead of failing the job', async () => {
    const { pool: proxies, advanceTimers } = pool({
      names: ['a'],
      maxConsecutiveFailures: 1,
      cooldownMs: 1_000,
      acquireWaitMs: 5_000,
    });

    const lease = (await proxies.acquire())!;
    proxies.reportFailure(lease, 'timeout', 'timeout');
    proxies.release(lease);
    expect(stateOf(proxies, lease.id)).toBe('cooling');

    let settled = false;
    const pending = proxies.acquire().then((granted) => {
      settled = true;
      return granted;
    });

    await flush();
    expect(settled).toBe(false);

    await advanceTimers(1_000);
    await expect(pending).resolves.not.toBeNull();
    // A wait that ended in a lease is latency, not degradation.
    expect(proxies.getStats().poolExhaustedCount).toBe(0);
  });

  it('waits for a source to admit a replacement while the roster is unusable', async () => {
    const { pool: proxies } = pool({
      names: ['a'],
      maxConsecutiveFailures: 1,
      // Far outside the budget: nothing but the pending supply justifies waiting.
      cooldownMs: 600_000,
      acquireWaitMs: 5_000,
    });
    proxies.setSourceStatsProvider(() => sourceStats({ candidates: 5 }));

    const lease = (await proxies.acquire())!;
    proxies.reportFailure(lease, 'timeout', 'timeout');
    proxies.release(lease);

    let settled = false;
    const pending = proxies.acquire().then((granted) => {
      settled = true;
      return granted;
    });

    await flush();
    expect(settled).toBe(false);

    proxies.add([target('b')], 'fake');
    await flush();

    await expect(pending).resolves.toMatchObject({ id: 'http://b.example.net:8000' });
    expect(proxies.getStats().poolExhaustedCount).toBe(0);
  });

  it('fails at once when every proxy is retired and nothing can replace them', async () => {
    // Retirement does not expire and no source is attached, so waiting cannot
    // produce a proxy. The test would time out if the pool waited anyway.
    const { pool: proxies } = pool({ names: ['a'], maxConsecutiveFailures: 1 });

    const lease = (await proxies.acquire())!;
    proxies.reportUnsuitable(lease, 'HTTP 451');
    proxies.release(lease);
    expect(proxies.getStats().retired).toBe(1);

    await expect(proxies.acquire()).rejects.toThrow(/blocked or cooling down/);
    expect(proxies.getStats().poolExhaustedCount).toBe(1);
  });

  it('gives up once the budget runs out, and counts that as an exhaustion', async () => {
    const { pool: proxies, advanceTimers } = pool({
      names: ['a'],
      maxConsecutiveFailures: 1,
      cooldownMs: 600_000,
      acquireWaitMs: 5_000,
    });
    proxies.setSourceStatsProvider(() => sourceStats({ candidates: 5 }));

    const lease = (await proxies.acquire())!;
    proxies.reportFailure(lease, 'timeout', 'timeout');
    proxies.release(lease);

    const pending = proxies.acquire();
    const rejected = expect(pending).rejects.toThrow(/blocked or cooling down/);
    await flush();

    await advanceTimers(5_000);
    await rejected;
    // Still retryable, so the retry policy's backoff absorbs it exactly as before.
    expect(proxies.getStats().poolExhaustedCount).toBe(1);
  });

  it('never answers "go direct" when an empty roster is being fed by a source', async () => {
    const { pool: proxies } = pool({ names: [], requireProxy: true, acquireWaitMs: 5_000 });
    proxies.setSourceStatsProvider(() => sourceStats({ validating: 3 }));

    let settled = false;
    const pending = proxies.acquire().then((granted) => {
      settled = true;
      return granted;
    });

    await flush();
    // Eviction can empty a source-fed roster for a tick. Reading that as "no
    // proxies wanted" would put the origin IP on the wire.
    expect(settled).toBe(false);

    proxies.add([target('fresh')], 'fake');
    await flush();

    await expect(pending).resolves.toMatchObject({ id: 'http://fresh.example.net:8000' });
  });

  it('fails rather than returning null when an empty roster has no supply behind it', async () => {
    const { pool: proxies } = pool({ names: [], requireProxy: true });

    await expect(proxies.acquire()).rejects.toThrow(/empty/);
    expect(proxies.getStats().poolExhaustedCount).toBe(1);
  });

  it('still goes direct when no proxies were ever configured', async () => {
    // The default for local development, and the reason nothing in this
    // repository needs proxy credentials to run.
    const { pool: proxies } = pool({ names: [] });

    await expect(proxies.acquire()).resolves.toBeNull();
    expect(proxies.getStats().poolExhaustedCount).toBe(0);
  });

  it('does not strand a caller that is cancelled while waiting for capacity', async () => {
    const { pool: proxies } = pool({
      names: ['a'],
      maxConsecutiveFailures: 1,
      cooldownMs: 600_000,
      acquireWaitMs: 5_000,
    });
    proxies.setSourceStatsProvider(() => sourceStats({ candidates: 1 }));
    const controller = new AbortController();

    const lease = (await proxies.acquire())!;
    proxies.reportFailure(lease, 'timeout', 'timeout');
    proxies.release(lease);

    const waiting = proxies.acquire(controller.signal);
    await flush();
    controller.abort();

    await expect(waiting).rejects.toThrow();
  });
});

describe('InMemoryProxyPool observability', () => {
  it('reports a proxy that has never been used as untested', () => {
    const { pool: proxies } = pool({ names: ['a', 'b'] });
    const stats = proxies.getStats();

    expect(stats.untested).toBe(2);
    expect(stats.perProxy.map((entry) => entry.state)).toEqual(['untested', 'untested']);
    expect(stats.perProxy[0]?.label).toBe('p1');
    expect(stats.perProxy[1]?.label).toBe('p2');
  });

  it('walks a failing proxy from healthy through probation into cooling and back', async () => {
    const {
      pool: proxies,
      advance,
      events,
    } = pool({
      names: ['a', 'b'],
      maxConsecutiveFailures: 2,
      cooldownMs: 60_000,
    });

    const first = (await proxies.acquire())!;
    proxies.reportSuccess(first);
    proxies.release(first);
    expect(stateOf(proxies, first.id)).toBe('healthy');

    proxies.reportFailure(first, 'timeout', 'timeout');
    expect(stateOf(proxies, first.id)).toBe('probation');

    proxies.reportFailure(first, 'timeout', 'timeout');
    expect(stateOf(proxies, first.id)).toBe('cooling');

    // Still cooling one millisecond short of the deadline.
    advance(59_999);
    expect(stateOf(proxies, first.id)).toBe('cooling');

    advance(1);
    // A served cooldown clears the failure counter, so a proxy that had already
    // proved itself comes back trusted rather than one failure from the bench.
    expect(stateOf(proxies, first.id)).toBe('healthy');

    // A proxy stops being `untested` the moment it is leased rather than when
    // the first outcome lands, so the first transition is out of probation.
    expect(events.map((event) => `${event.from}->${event.to}`)).toEqual([
      'probation->healthy',
      'healthy->probation',
      'probation->cooling',
      'cooling->healthy',
    ]);
  });

  it('records when a proxy went bad, why, and when it is due back', async () => {
    const { pool: proxies, advance } = pool({
      names: ['a'],
      maxConsecutiveFailures: 1,
      cooldownMs: 5_000,
    });

    const lease = (await proxies.acquire())!;
    advance(1_000);
    proxies.markBlocked(
      lease,
      'HTTP 429 from https://user:secret@gate.example.net:8000',
      'blocked',
    );
    proxies.release(lease);

    const entry = proxies.getStats().perProxy[0]!;
    expect(entry.state).toBe('cooling');
    expect(entry.blockKind).toBe('detected_block');
    expect(entry.unhealthySince).toBe(1_000);
    expect(entry.eligibleAt).toBe(6_000);
    expect(entry.lastErrorCode).toBe('blocked');
    expect(entry.lastFailureAt).toBe(1_000);
    // The reason is kept for reading, with any credentials stripped out of it.
    expect(entry.lastReason).toContain('//***@');
    expect(entry.lastReason).not.toContain('secret');
  });

  it('emits one transition for a retirement, not one per failure', async () => {
    const { pool: proxies, events } = pool({ names: ['a'], maxConsecutiveFailures: 2 });

    for (let i = 0; i < 2; i += 1) {
      const lease = (await proxies.acquire())!;
      proxies.reportUnsuitable(lease, 'HTTP 451', 'geo_blocked');
      proxies.release(lease);
    }

    expect(proxies.getStats().perProxy[0]?.state).toBe('retired');
    expect(events.filter((event) => event.to === 'retired')).toHaveLength(1);
    expect(events.at(-1)?.blockKind).toBe('unsuitable_exit');
  });

  it('does not emit a transition when a busy proxy fills up', async () => {
    const { pool: proxies, events } = pool({ names: ['a'], maxConcurrentPerProxy: 2 });

    const first = (await proxies.acquire())!;
    proxies.reportSuccess(first);
    const second = (await proxies.acquire())!;

    // Full, but perfectly healthy: capacity is not a health change, and
    // treating it as one would flap on every lease.
    expect(stateOf(proxies, first.id)).toBe('saturated');
    expect(proxies.getStats().saturated).toBe(1);
    expect(events.map((event) => event.to)).toEqual(['healthy']);
    proxies.release(second);
  });

  it('counts the times the whole pool was out at once', async () => {
    const { pool: proxies } = pool({
      names: ['a'],
      maxConsecutiveFailures: 1,
      cooldownMs: 1_000,
      // The counter means "gave up and threw", so it is measured with waiting
      // off; an attempt that waits and then succeeds is not an exhaustion.
      acquireWaitMs: 0,
    });

    const lease = (await proxies.acquire())!;
    proxies.reportFailure(lease, 'timeout', 'timeout');
    proxies.release(lease);

    await expect(proxies.acquire()).rejects.toThrow(/blocked or cooling down/);
    await expect(proxies.acquire()).rejects.toThrow(/blocked or cooling down/);

    expect(proxies.getStats().poolExhaustedCount).toBe(2);
  });

  it('reports the capacity the pool has earned, not the capacity it may reach', async () => {
    const { pool: proxies } = pool({ names: ['a', 'b'], maxConcurrentPerProxy: 4 });

    // `proxies × limit` is 8, but nothing has earned anything yet.
    expect(proxies.getStats().capacity).toBe(2);

    await prove(proxies, 2);
    expect(proxies.getStats().capacity).toBe(4);

    await prove(proxies, 2);
    expect(proxies.getStats().capacity).toBe(8);

    const held = (await proxies.acquire())!;
    const stats = proxies.getStats();
    expect(stats.capacity).toBe(8);
    expect(stats.totalInFlight).toBe(1);
    expect(stats.inUse).toBe(1);
    proxies.release(held);
  });

  it('keeps two entries on the same host:port separate', async () => {
    const shared: ProxyTarget[] = [
      {
        ...target('gate'),
        username: 'session-1',
        url: 'http://session-1:pw@gate.example.net:8000',
      },
      {
        ...target('gate'),
        username: 'session-2',
        url: 'http://session-2:pw@gate.example.net:8000',
      },
    ];
    const { pool: proxies } = pool({ names: [], targets: shared, maxConsecutiveFailures: 1 });

    const stats = proxies.getStats();
    expect(new Set(stats.perProxy.map((entry) => entry.id)).size).toBe(2);
    // The credentials that distinguish them never appear in the id.
    for (const entry of stats.perProxy) {
      expect(entry.id).not.toContain('session-');
      expect(entry.id).not.toContain('pw');
    }

    // One failing must not bench the other.
    const first = (await proxies.acquire())!;
    proxies.reportFailure(first, 'timeout', 'timeout');
    proxies.release(first);

    const after = proxies.getStats();
    expect(after.perProxy.filter((entry) => entry.state === 'cooling')).toHaveLength(1);
    expect(after.available).toBe(1);
  });
});

function stateOf(instance: InMemoryProxyPool, id: string): string | undefined {
  return instance.getStats().perProxy.find((entry) => entry.id === id)?.state;
}

describe('InMemoryProxyPool roster', () => {
  it('adds proxies while the pool is running and wakes anything waiting for capacity', async () => {
    const { pool: proxies } = pool({ names: ['a'], maxConcurrentPerProxy: 1 });

    const held = (await proxies.acquire())!;
    proxies.reportSuccess(held);

    // The pool is full, so this cannot resolve until capacity appears.
    let settled = false;
    const waiting = proxies.acquire().then((lease) => {
      settled = true;
      return lease;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    expect(proxies.add([target('b')], 'fake')).toBe(1);
    const lease = await waiting;

    expect(lease?.id).toBe('http://b.example.net:8000');
    expect(proxies.getStats().configured).toBe(2);
  });

  it('ignores an id it already holds instead of resetting that proxy', async () => {
    const { pool: proxies } = pool({ names: ['a'] });

    const lease = (await proxies.acquire())!;
    proxies.reportFailure(lease, 'boom', 'network_error');
    proxies.release(lease);

    // A source that lists the same proxy on every refresh must not be able to
    // wipe its history simply by naming it again.
    expect(proxies.add([target('a')], 'fake')).toBe(0);
    expect(proxies.getStats().configured).toBe(1);
    expect(proxies.getStats().perProxy[0]?.consecutiveFailures).toBe(1);
    expect(proxies.getStats().perProxy[0]?.source).toBe('config');
  });

  it('keeps two entries on one host:port apart when their credentials differ', () => {
    const { pool: proxies } = pool({ names: [], targets: [] });
    const base = target('gate');

    expect(
      proxies.add([{ ...base, username: 'one', url: 'http://one:p@gate.example.net:8000' }]),
    ).toBe(1);
    expect(
      proxies.add([{ ...base, username: 'two', url: 'http://two:p@gate.example.net:8000' }]),
    ).toBe(1);

    const ids = proxies.getStats().perProxy.map((proxy) => proxy.id);
    expect(new Set(ids).size).toBe(2);
    // The credential never reaches the id, only a digest of the full URL.
    for (const id of ids) expect(id).not.toContain('p@');
  });

  it('evicts an idle proxy but refuses one that still owes an outcome', async () => {
    const { pool: proxies } = pool({ names: ['a', 'b'] });

    const lease = (await proxies.acquire())!;
    // The job still holds the target and will report against it; dropping the
    // entry underneath it would silently discard that outcome.
    expect(proxies.evict(lease.id)).toBe(false);

    proxies.release(lease);
    expect(proxies.evict(lease.id)).toBe(true);
    expect(proxies.getStats().configured).toBe(1);
    expect(proxies.evict(lease.id)).toBe(false);
  });

  it('never reuses a label after churn', () => {
    const { pool: proxies } = pool({ names: ['a'] });

    proxies.add([target('b')], 'fake');
    proxies.evict('http://a.example.net:8000');
    proxies.add([target('c')], 'fake');

    const labels = proxies.getStats().perProxy.map((proxy) => proxy.label);
    // Indices are reused as proxies come and go; a label that silently changes
    // meaning is worse than no label at all.
    expect(labels).toEqual(['p2', 'p3']);
  });

  it('records where each proxy came from', () => {
    const { pool: proxies } = pool({ names: ['a'] });
    proxies.add([target('b')], 'proxyscrape');

    const bySource = Object.fromEntries(
      proxies.getStats().perProxy.map((proxy) => [proxy.label, proxy.source]),
    );
    expect(bySource).toEqual({ p1: 'config', p2: 'proxyscrape' });
  });
});
