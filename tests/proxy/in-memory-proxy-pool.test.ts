import { describe, expect, it } from 'vitest';

import { ScrapeError } from '../../src/core/models/errors.js';
import { type ProxyTarget } from '../../src/core/scraper/lease-ports.js';
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
  maxConcurrentPerProxy?: number;
  cooldownMs?: number;
  maxConsecutiveFailures?: number;
}): { pool: InMemoryProxyPool; advance: (ms: number) => void } {
  let current = 0;
  const instance = new InMemoryProxyPool({
    targets: options.names.map(target),
    now: () => current,
    ...(options.maxConcurrentPerProxy === undefined
      ? {}
      : { maxConcurrentPerProxy: options.maxConcurrentPerProxy }),
    ...(options.cooldownMs === undefined ? {} : { cooldownMs: options.cooldownMs }),
    ...(options.maxConsecutiveFailures === undefined
      ? {}
      : { maxConsecutiveFailures: options.maxConsecutiveFailures }),
  });
  return {
    pool: instance,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/**
 * Walks every proxy through one success, which is what takes them off
 * probation. Capacity tests are about the steady state, not the ramp.
 *
 * The leases are held until every proxy has one, because an unproven proxy
 * only takes one job at a time — releasing between acquisitions would hand
 * them all to whichever proxy proved itself first.
 */
async function prove(instance: InMemoryProxyPool, count: number): Promise<void> {
  const leases = [];
  for (let i = 0; i < count; i += 1) {
    leases.push((await instance.acquire())!);
  }
  for (const lease of leases) {
    instance.reportSuccess(lease);
    instance.release(lease);
  }
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

  it('caps a failing proxy at one in-flight job while healthy ones stay open', async () => {
    const { pool: proxies } = pool({ names: ['a', 'b'], maxConcurrentPerProxy: 4 });
    await prove(proxies, 2);

    // Put 'a' into an unresolved-failure state; 'b' stays healthy.
    const first = await proxies.acquire();
    const dead = first!.id;
    proxies.reportFailure(first!, 'timeout');
    proxies.release(first!);

    const leases: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const lease = await proxies.acquire();
      leases.push(lease!.id);
    }

    // The suspect proxy takes exactly one of the five; the proven one absorbs
    // the rest rather than the pool serializing on the failure.
    expect(leases.filter((id) => id === dead)).toHaveLength(1);
    expect(leases.filter((id) => id !== dead)).toHaveLength(4);
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
    const { pool: proxies } = pool({ names: ['a'], maxConsecutiveFailures: 1 });

    const lease = await proxies.acquire();
    proxies.markBlocked(lease!, 'blocked');
    proxies.release(lease!);

    // Silently falling back to a direct connection would expose the origin IP.
    await expect(proxies.acquire()).rejects.toThrow(ScrapeError);
    await expect(proxies.acquire()).rejects.toThrow(/blocked or cooling down/);
  });

  it('clears a cooldown once the proxy succeeds again', async () => {
    const { pool: proxies } = pool({ names: ['a'], maxConsecutiveFailures: 1 });

    const lease = await proxies.acquire();
    proxies.reportFailure(lease!, 'timeout');
    expect(proxies.getStats().perProxy[0]?.cooldownUntil).not.toBeNull();

    proxies.reportSuccess(lease!);
    expect(proxies.getStats().perProxy[0]?.cooldownUntil).toBeNull();
    expect(proxies.getStats().perProxy[0]?.consecutiveFailures).toBe(0);
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
