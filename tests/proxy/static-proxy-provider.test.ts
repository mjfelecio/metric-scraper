import { describe, expect, it } from 'vitest';

import { type ScrapeErrorCode } from '../../src/core/models/errors.js';
import {
  type ProxyLease,
  type ProxyOutcome,
  type ProxyTarget,
} from '../../src/core/scraper/lease-ports.js';
import { type ProxyPool, type ProxyPoolStats } from '../../src/core/scraper/pool-ports.js';
import { NullProxyPool } from '../../src/infrastructure/proxy/in-memory-proxy-pool.js';
import { StaticProxyProvider } from '../../src/infrastructure/proxy/static-proxy-provider.js';

function target(): ProxyTarget {
  return {
    protocol: 'http',
    host: 'proxy-a.example.net',
    port: 8000,
    username: null,
    password: null,
    url: 'http://proxy-a.example.net:8000',
  };
}

const LEASE: ProxyLease = { id: 'http://proxy-a.example.net:8000', target: target() };

/** Records what the provider asked the pool to do, in the order it asked. */
class RecordingPool implements ProxyPool {
  readonly calls: { method: string; reason?: string | undefined }[] = [];
  acquireSignals: (AbortSignal | undefined)[] = [];

  acquire(signal?: AbortSignal): Promise<ProxyLease | null> {
    this.acquireSignals.push(signal);
    return Promise.resolve(LEASE);
  }
  release(): void {
    this.calls.push({ method: 'release' });
  }
  reportSuccess(): void {
    this.calls.push({ method: 'reportSuccess' });
  }
  reportFailure(_lease: ProxyLease, reason?: string): void {
    this.calls.push({ method: 'reportFailure', reason });
  }
  reportUnsuitable(_lease: ProxyLease, reason?: string): void {
    this.calls.push({ method: 'reportUnsuitable', reason });
  }
  markBlocked(_lease: ProxyLease, reason?: string): void {
    this.calls.push({ method: 'markBlocked', reason });
  }
  getStats(): ProxyPoolStats {
    return {
      configured: 1,
      available: 1,
      inUse: 0,
      blocked: 0,
      retired: 0,
      untested: 0,
      cooling: 0,
      saturated: 0,
      totalInFlight: 0,
      capacity: 4,
      poolExhaustedCount: 0,
      totalRequests: 0,
      totalFailures: 0,
      source: null,
      perProxy: [],
    };
  }
}

describe('StaticProxyProvider', () => {
  it.each([
    ['success', 'reportSuccess'],
    ['failure', 'reportFailure'],
    ['unsuitable', 'reportUnsuitable'],
    ['blocked', 'markBlocked'],
  ] as const)('routes a %s outcome to %s', (outcome, method) => {
    const pool = new RecordingPool();

    new StaticProxyProvider(pool).release(LEASE, outcome);

    // Health first, release last. That ordering is load-bearing: releasing is
    // what wakes a job waiting on capacity, so the health it will read must
    // already be recorded by then.
    expect(pool.calls.map((call) => call.method)).toEqual([method, 'release']);
  });

  it('neither credits nor blames the proxy for a neutral outcome', () => {
    const pool = new RecordingPool();

    new StaticProxyProvider(pool).release(LEASE, 'neutral');

    // The regression this guards is the older behaviour where anything that was
    // not an outright failure counted as a success, which let a dead proxy keep
    // resetting its own failure count on cancelled attempts.
    expect(pool.calls.map((call) => call.method)).toEqual(['release']);
  });

  it('passes the reason and error code through to the pool', () => {
    const pool = new RecordingPool();
    const detail = { reason: 'HTTP 503', errorCode: 'http_error' as ScrapeErrorCode };

    new StaticProxyProvider(pool).release(LEASE, 'failure', detail);

    expect(pool.calls[0]).toEqual({ method: 'reportFailure', reason: 'HTTP 503' });
  });

  it('releases the lease for every outcome, without exception', () => {
    const outcomes: ProxyOutcome[] = ['success', 'failure', 'unsuitable', 'blocked', 'neutral'];

    for (const outcome of outcomes) {
      const pool = new RecordingPool();
      new StaticProxyProvider(pool).release(LEASE, outcome);

      expect(pool.calls.at(-1)?.method, `${outcome} must still release`).toBe('release');
    }
  });

  it('forwards the abort signal to the pool and ignores the rest of the context', async () => {
    const pool = new RecordingPool();
    const signal = new AbortController().signal;

    await new StaticProxyProvider(pool).acquire({ platform: 'tiktok', attempt: 2, signal });

    expect(pool.acquireSignals).toEqual([signal]);
  });

  it('keeps the go-direct path when no proxies are configured', async () => {
    // NullProxyPool is what the composition root builds with an empty
    // PROXY_POOL, and `null` is how the runner is told to go out directly. The
    // provider must not turn that into a lease.
    const provider = new StaticProxyProvider(new NullProxyPool());

    await expect(provider.acquire({ platform: 'tiktok', attempt: 1 })).resolves.toBeNull();
  });

  it('reports the pool stats unchanged, tagged with the mode', () => {
    const pool = new RecordingPool();
    const provider = new StaticProxyProvider(pool);

    expect(provider.mode).toBe('static');
    expect(provider.getStats()).toEqual({ ...pool.getStats(), mode: 'static' });
  });
});
