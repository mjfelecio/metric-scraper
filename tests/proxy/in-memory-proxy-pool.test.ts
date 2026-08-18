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

  it('shares a proxy without limit when no per-proxy cap is set', async () => {
    const { pool: proxies } = pool({ names: ['a'] });

    const first = await proxies.acquire();
    const second = await proxies.acquire();

    expect(first!.id).toBe(second!.id);
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
