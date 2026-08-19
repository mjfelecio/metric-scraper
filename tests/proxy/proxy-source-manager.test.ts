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

function build(options: {
  list: ProxyTarget[];
  passes?: ((target: ProxyTarget) => boolean) | undefined;
  desiredActive?: number | undefined;
  minHealthy?: number | undefined;
  validateConcurrency?: number | undefined;
  configured?: string[] | undefined;
}) {
  const pool = new InMemoryProxyPool({
    targets: (options.configured ?? []).map(parseProxyEntry),
    maxConsecutiveFailures: 2,
    cooldownMs: 60_000,
    maxConcurrentPerProxy: 4,
  });
  const source = new FakeSource(options.list);
  const probe = new FakeProbe(options.passes ?? (() => true));
  const manager = new ProxySourceManager({
    source,
    probe,
    roster: pool,
    desiredActive: options.desiredActive ?? 5,
    minHealthy: options.minHealthy ?? 1,
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
      desiredActive: 5,
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
    const { probe, manager } = build({ list: targets(500), desiredActive: 4 });

    await manager.refreshOnce();
    await manager.replenishOnce();

    expect(probe.probed).toHaveLength(4);
  });

  it('never runs more probes at once than its configured concurrency', async () => {
    const { probe, manager } = build({
      list: targets(50),
      desiredActive: 40,
      validateConcurrency: 6,
    });

    await manager.refreshOnce();
    await manager.replenishOnce();

    expect(probe.maxInFlight).toBeLessThanOrEqual(6);
  });

  it('stops validating once the pool is at strength', async () => {
    const { probe, manager } = build({ list: targets(20), desiredActive: 3 });

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
      desiredActive: 3,
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
    const { pool, source, manager } = build({ list: targets(1), desiredActive: 3 });

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
    const { pool, manager } = build({ list: targets(4), desiredActive: 1 });

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
    const { pool, manager } = build({ list: targets(4), desiredActive: 1 });

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
      desiredActive: 2,
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
    const { pool, source, manager } = build({ list: targets(3), desiredActive: 3 });

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
      desiredActive: 3,
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
    expect(source?.desiredActive).toBe(3);
  });

  it('keeps validating on start until the minimum healthy size is met', async () => {
    // Most candidates on a free list fail, and one pass probes only the
    // deficit — so a single round routinely leaves the floor unmet.
    const passing = new Set(['10.0.0.9', '10.0.0.10', '10.0.0.11']);
    const { pool, probe, manager } = build({
      list: targets(20),
      passes: (target) => passing.has(target.host),
      desiredActive: 3,
      minHealthy: 3,
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
      desiredActive: 5,
      minHealthy: 5,
    });

    await manager.start();
    manager.stop();

    expect(pool.getStats().available).toBe(0);
    expect(probe.probed.length).toBeLessThan(100);
  });
});
