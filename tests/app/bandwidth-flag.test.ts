import { describe, expect, it, vi } from 'vitest';

import type * as Undici from 'undici';

/**
 * A fake `ProxyAgent` whose `compose()` returns an object distinct from the
 * base instance — mirroring undici's real `Dispatcher.compose()` (verified
 * against undici@7: `base.compose(fn) !== base`). This lets the tests below
 * assert on object identity rather than on the vacuous `sink.view().requests
 * === 0`, which is trivially true whenever no request is ever issued.
 */
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof Undici>();
  return {
    ...actual,
    ProxyAgent: vi.fn().mockImplementation((options: unknown) => {
      const compose = vi.fn((interceptor: unknown): unknown => ({
        __composed: true,
        __options: options,
        interceptor,
      }));
      return { __bareProxyAgent: true, __options: options, compose };
    }),
  };
});

import { ProxyAgent } from 'undici';

import { createProxyAgentFactory } from '../../src/app/composition.js';
import { BandwidthAggregator } from '../../src/core/metrics/bandwidth.js';
import { type ProxyTarget } from '../../src/core/scraper/lease-ports.js';

const target: ProxyTarget = {
  url: 'http://user:pass@127.0.0.1:8000',
  protocol: 'http',
  host: '127.0.0.1',
  port: 8000,
  username: 'user',
  password: 'pass',
};

function configWith(metricsBandwidth: boolean): never {
  // Only the two fields the factory reads; cast because the real AppConfig is large.
  return { metricsBandwidth, proxy: { connectTimeoutMs: 3_000 } } as never;
}

describe('bandwidth flag', () => {
  it('records nothing and composes no interceptor through the proxy factory when disabled', () => {
    const sink = new BandwidthAggregator();
    const factory = createProxyAgentFactory(configWith(false), sink);

    const agent = factory(target);

    // With the flag off, the factory must hand back the bare ProxyAgent
    // itself — not something built from calling `.compose()` on it.
    const baseInstance = vi.mocked(ProxyAgent).mock.results[0]?.value as {
      compose: ReturnType<typeof vi.fn>;
    };
    expect(agent).toBe(baseInstance);
    expect(baseInstance.compose).not.toHaveBeenCalled();
    expect(sink.view().requests).toBe(0);
  });

  it('composes the interceptor onto a distinct dispatcher object when enabled', () => {
    const sink = new BandwidthAggregator();
    const factory = createProxyAgentFactory(configWith(true), sink);

    const agent = factory(target);

    const baseInstance = vi.mocked(ProxyAgent).mock.results[0]?.value as {
      compose: ReturnType<typeof vi.fn>;
    };
    // A composed dispatcher is a different object identity from the bare
    // ProxyAgent; with the flag on the interceptor must be attached.
    expect(agent).not.toBe(baseInstance);
    expect(baseInstance.compose).toHaveBeenCalledTimes(1);
  });

  it('caches one agent per proxy url rather than building one per request', () => {
    const factory = createProxyAgentFactory(configWith(true), new BandwidthAggregator());
    expect(factory(target)).toBe(factory(target));
  });
});
