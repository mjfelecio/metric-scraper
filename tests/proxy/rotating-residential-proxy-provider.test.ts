import { describe, expect, it } from 'vitest';

import { type ProxyLease } from '../../src/core/scraper/lease-ports.js';
import { buildProxyTarget } from '../../src/infrastructure/proxy/proxy-config.js';
import { RotatingResidentialProxyProvider } from '../../src/infrastructure/proxy/rotating-residential-proxy-provider.js';

function provider(): RotatingResidentialProxyProvider {
  return new RotatingResidentialProxyProvider({
    target: buildProxyTarget({
      protocol: 'http',
      host: 'gate.residential.example.net',
      port: 7000,
      username: 'account-1',
      password: 'secret',
    }),
  });
}

/** Acquire, then report the outcome, the way the runner does per attempt. */
async function attempt(
  subject: RotatingResidentialProxyProvider,
  outcome: 'success' | 'failure' | 'unsuitable' | 'blocked' | 'neutral',
): Promise<ProxyLease> {
  const lease = await subject.acquire();
  subject.release(lease as ProxyLease, outcome);
  return lease as ProxyLease;
}

describe('RotatingResidentialProxyProvider', () => {
  it('never returns null, so a residential run cannot fall back to the origin IP', async () => {
    const subject = provider();

    for (let i = 0; i < 5; i += 1) {
      await expect(subject.acquire()).resolves.not.toBeNull();
    }
  });

  it('hands out one stable gateway id rather than a rotating one', async () => {
    // The exit IP rotates on the provider's side and we never learn it. The
    // gateway is what we can name, so it is what metrics key on.
    const subject = provider();

    const first = await subject.acquire();
    const second = await subject.acquire();

    expect(first?.id).toBe('http://gate.residential.example.net:7000');
    expect(second?.id).toBe(first?.id);
  });

  it('keeps credentials out of the id while still carrying them in the target', async () => {
    const lease = await provider().acquire();

    expect(lease?.id).not.toContain('secret');
    expect(lease?.id).not.toContain('account-1');
    expect(lease?.target.url).toContain('secret');
    expect(lease?.target.username).toBe('account-1');
  });

  it('never benches the gateway, however many failures it sees', async () => {
    const subject = provider();

    for (let i = 0; i < 50; i += 1) {
      await attempt(subject, 'failure');
    }
    const stats = subject.getStats();

    // The point of the whole class: a failure is evidence about one exit IP we
    // will never be handed again, so benching on it would take the entire run
    // offline for no reason.
    expect(stats.blocked).toBe(0);
    expect(stats.cooling).toBe(0);
    expect(stats.retired).toBe(0);
    expect(stats.available).toBe(1);
    expect(stats.perProxy[0]).toMatchObject({
      state: 'healthy',
      blocked: false,
      retired: false,
      cooldownUntil: null,
      eligibleAt: null,
    });
    await expect(subject.acquire()).resolves.not.toBeNull();
  });

  it('does not retire the gateway on repeated unsuitable outcomes', async () => {
    // A static proxy is retired for good after consecutive 451s, because a
    // jurisdiction does not change. A residential exit is different every time.
    const subject = provider();

    for (let i = 0; i < 10; i += 1) {
      await attempt(subject, 'unsuitable');
    }

    expect(subject.getStats().retired).toBe(0);
    expect(subject.getStats().perProxy[0]?.unsuitable).toBe(10);
  });

  it('does not block the gateway when the platform blocks an exit IP', async () => {
    const subject = provider();

    await attempt(subject, 'blocked');

    expect(subject.getStats().blocked).toBe(0);
    expect(subject.getStats().perProxy[0]?.blocked).toBe(false);
    expect(subject.blockedOutcomes).toBe(1);
  });

  it('reports exactly one row, describing the gateway rather than a roster', async () => {
    const subject = provider();
    await attempt(subject, 'success');

    const stats = subject.getStats();

    expect(stats.mode).toBe('rotating-residential');
    expect(stats.configured).toBe(1);
    expect(stats.perProxy).toHaveLength(1);
    // No pool-shaped ceiling: the run is bounded by SCRAPER_CONCURRENCY alone.
    expect(stats.capacity).toBeNull();
    expect(stats.perProxy[0]?.capacity).toBeNull();
    // `acquire` cannot fail, so pool exhaustion has no analogue here.
    expect(stats.poolExhaustedCount).toBe(0);
  });

  it('is untested until the first lease and healthy afterwards', async () => {
    const subject = provider();

    expect(subject.getStats().untested).toBe(1);
    expect(subject.getStats().perProxy[0]?.state).toBe('untested');

    await attempt(subject, 'success');

    expect(subject.getStats().untested).toBe(0);
    expect(subject.getStats().perProxy[0]?.state).toBe('healthy');
  });

  it('tallies outcomes so the two modes can be compared on the same fields', async () => {
    const subject = provider();

    await attempt(subject, 'success');
    await attempt(subject, 'success');
    await attempt(subject, 'failure');
    await attempt(subject, 'unsuitable');

    expect(subject.getStats()).toMatchObject({ totalRequests: 4, totalFailures: 2 });
    expect(subject.getStats().perProxy[0]).toMatchObject({
      requests: 4,
      successes: 2,
      failures: 2,
      unsuitable: 1,
    });
  });

  it('leaves a neutral outcome out of the tallies entirely', async () => {
    const subject = provider();

    await attempt(subject, 'neutral');

    expect(subject.getStats().perProxy[0]).toMatchObject({
      successes: 0,
      failures: 0,
      lastReason: null,
    });
  });

  it('tracks in-flight leases so a run reports its real gateway load', async () => {
    const subject = provider();

    const first = await subject.acquire();
    const second = await subject.acquire();

    expect(subject.getStats().totalInFlight).toBe(2);

    subject.release(first as ProxyLease, 'success');
    subject.release(second as ProxyLease, 'success');

    expect(subject.getStats().totalInFlight).toBe(0);
  });

  it('records the last failure reason without a credential in it', async () => {
    const subject = provider();
    const lease = await subject.acquire();

    subject.release(lease as ProxyLease, 'failure', {
      reason: 'HTTP 503',
      errorCode: 'http_error',
    });

    expect(subject.getStats().perProxy[0]).toMatchObject({
      lastReason: 'HTTP 503',
      lastErrorCode: 'http_error',
    });
  });
});

describe('buildProxyTarget', () => {
  it('encodes credentials so a password with URL syntax cannot corrupt the host', () => {
    // A gateway password containing `@` would otherwise reparse into a
    // different host entirely — the request would leave through the wrong place
    // rather than fail loudly.
    const target = buildProxyTarget({
      protocol: 'http',
      host: 'gate.example.net',
      port: 7000,
      username: 'user',
      password: 'p@ss:word',
    });

    expect(new URL(target.url).hostname).toBe('gate.example.net');
    expect(target.password).toBe('p@ss:word');
  });

  it('treats an empty credential as absent rather than as an empty one', () => {
    const target = buildProxyTarget({ protocol: 'http', host: 'gate.example.net', port: 7000 });

    expect(target.username).toBeNull();
    expect(target.password).toBeNull();
    expect(target.url).toBe('http://gate.example.net:7000/');
  });

  it('rejects a host or port that could not work', () => {
    expect(() => buildProxyTarget({ protocol: 'http', host: '', port: 7000 })).toThrow(/host/);
    expect(() => buildProxyTarget({ protocol: 'http', host: 'gate.example.net', port: 0 })).toThrow(
      /port/,
    );
  });
});
