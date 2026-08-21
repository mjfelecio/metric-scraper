import { describe, expect, it, vi } from 'vitest';

import type * as Undici from 'undici';

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof Undici>();
  return {
    ...actual,
    Agent: vi.fn().mockImplementation(() => {
      const agent = {
        compose: vi.fn(() => agent),
        close: vi.fn(() => Promise.resolve()),
      };
      return agent;
    }),
    ProxyAgent: vi.fn().mockImplementation((options: unknown) => {
      // A bandwidth-measurement no-op: these tests are about ProxyAgent
      // construction and caching, not about the interceptor, so `compose`
      // just returns the same object rather than modeling undici's real
      // (distinct-object) behavior.
      const agent: {
        __options: unknown;
        compose: (interceptor: unknown) => unknown;
        close: () => Promise<void>;
      } = {
        __options: options,
        compose: () => agent,
        close: vi.fn(() => Promise.resolve()),
      };
      return agent;
    }),
  };
});

import { Agent, ProxyAgent } from 'undici';

import {
  buildRunner as buildComposedRunner,
  createManagedHttpTransport,
  createProxyAgentFactory,
  createProxySupply,
  maxWaitForHost,
  rpmForHost,
} from '../../src/app/composition.js';
import { loadConfig } from '../../src/config/env.js';
import { nullBandwidthSink, type BandwidthSink } from '../../src/core/metrics/bandwidth.js';
import { nullLogger } from '../../src/core/logging/logger.js';
import { type InputRecord } from '../../src/core/models/input.js';
import { MemorySnapshotSink } from '../../src/core/output/snapshot-sink.js';
import { type HttpClient, type HttpResponse } from '../../src/core/scraper/http-port.js';
import { type ProxyTarget } from '../../src/core/scraper/lease-ports.js';

function target(overrides: Partial<ProxyTarget> = {}): ProxyTarget {
  return {
    protocol: 'http',
    host: 'proxy.example.net',
    port: 8080,
    username: null,
    password: null,
    url: 'http://proxy.example.net:8080',
    ...overrides,
  };
}

describe('createProxyAgentFactory', () => {
  it('constructs the ProxyAgent with the configured connect timeout', () => {
    const config = loadConfig({ env: { PROXY_CONNECT_TIMEOUT_MS: '2500' }, dotenv: false });
    const factory = createProxyAgentFactory(config, nullBandwidthSink);

    factory(target());

    expect(ProxyAgent).toHaveBeenCalledWith({
      uri: 'http://proxy.example.net:8080',
      connectTimeout: 2500,
    });
  });

  it('defaults to 3000ms when PROXY_CONNECT_TIMEOUT_MS is unset', () => {
    const config = loadConfig({ env: {}, dotenv: false });
    const factory = createProxyAgentFactory(config, nullBandwidthSink);

    factory(target());

    expect(ProxyAgent).toHaveBeenCalledWith(expect.objectContaining({ connectTimeout: 3000 }));
  });

  it('reuses one agent per distinct proxy URL rather than building a new one per call', () => {
    const config = loadConfig({ env: {}, dotenv: false });
    const factory = createProxyAgentFactory(config, nullBandwidthSink);

    const first = factory(target());
    const second = factory(target());

    expect(first).toBe(second);
    expect(ProxyAgent).toHaveBeenCalledTimes(1);
  });

  it('builds a separate agent for a different proxy URL', () => {
    const config = loadConfig({ env: {}, dotenv: false });
    const factory = createProxyAgentFactory(config, nullBandwidthSink);

    factory(target({ url: 'http://a.example.net:8080', host: 'a.example.net' }));
    factory(target({ url: 'http://b.example.net:8080', host: 'b.example.net' }));

    expect(ProxyAgent).toHaveBeenCalledTimes(2);
  });

  it('refuses a proxy protocol the fetch transport cannot dispatch through', () => {
    const config = loadConfig({ env: {}, dotenv: false });
    const factory = createProxyAgentFactory(config, nullBandwidthSink);

    expect(() => factory(target({ protocol: 'socks5' }))).toThrow(/socks5/);
  });
});

describe('rpmForHost', () => {
  const byPlatform = { tiktok: 300, instagram: 180 };

  it('routes TikTok and its short-link hosts to the TikTok ceiling', () => {
    expect(rpmForHost('www.tiktok.com', byPlatform)).toBe(300);
    expect(rpmForHost('vm.tiktok.com', byPlatform)).toBe(300);
    expect(rpmForHost('vt.tiktok.com', byPlatform)).toBe(300);
  });

  it('routes Instagram and instagr.am hosts to the Instagram ceiling', () => {
    expect(rpmForHost('www.instagram.com', byPlatform)).toBe(180);
    expect(rpmForHost('i.instagram.com', byPlatform)).toBe(180);
    expect(rpmForHost('instagr.am', byPlatform)).toBe(180);
  });

  it('is case-insensitive', () => {
    expect(rpmForHost('WWW.TIKTOK.COM', byPlatform)).toBe(300);
  });

  it('falls back to the stricter configured limit for an unrecognized host', () => {
    expect(rpmForHost('example.net', byPlatform)).toBe(180);
  });

  it('falls back to whichever platform is actually limited when the other is 0', () => {
    expect(rpmForHost('example.net', { tiktok: 0, instagram: 180 })).toBe(180);
    expect(rpmForHost('example.net', { tiktok: 300, instagram: 0 })).toBe(300);
  });

  it('leaves an unrecognized host unlimited when neither platform is limited', () => {
    expect(rpmForHost('example.net', { tiktok: 0, instagram: 0 })).toBe(0);
  });
});

describe('maxWaitForHost', () => {
  const byPlatform = { tiktok: 7_500, instagram: 12_000 };

  it('routes each platform to its own queue budget', () => {
    expect(maxWaitForHost('www.tiktok.com', byPlatform)).toBe(7_500);
    expect(maxWaitForHost('vm.tiktok.com', byPlatform)).toBe(7_500);
    expect(maxWaitForHost('www.instagram.com', byPlatform)).toBe(12_000);
    expect(maxWaitForHost('instagr.am', byPlatform)).toBe(12_000);
  });

  it('classifies hosts the same way rpmForHost does', () => {
    // The two must agree, or a host could be paced by one platform's ceiling
    // while being bounded by the other platform's budget.
    for (const host of ['www.tiktok.com', 'i.instagram.com', 'instagr.am', 'example.net']) {
      const pacedBy = rpmForHost(host, { tiktok: 1, instagram: 2 });
      const boundedBy = maxWaitForHost(host, { tiktok: 1, instagram: 2 });
      if (host === 'example.net') continue;
      expect(boundedBy).toBe(pacedBy);
    }
  });

  it('gives an unrecognized host the most generous budget', () => {
    // The opposite of rpmForHost's fallback, on purpose: the stricter rate
    // protects upstream, but a hasty *budget* just fails work that would have
    // gone through.
    expect(maxWaitForHost('example.net', byPlatform)).toBe(12_000);
  });

  it('treats 0 as unbounded', () => {
    expect(maxWaitForHost('www.tiktok.com', { tiktok: 0, instagram: 12_000 })).toBeUndefined();
    expect(maxWaitForHost('example.net', { tiktok: 0, instagram: 0 })).toBeUndefined();
  });
});

describe('createManagedHttpTransport', () => {
  function dispatcherFactory(client: HttpClient): (target: ProxyTarget) => unknown {
    return (
      client as unknown as {
        options: { dispatcherFactory: (target: ProxyTarget) => unknown };
      }
    ).options.dispatcherFactory;
  }

  it('reuses proxy agents across cycle clients and closes every base agent once', async () => {
    const config = loadConfig({ env: { METRICS_BANDWIDTH: 'true' }, dotenv: false });
    const transport = createManagedHttpTransport(config);
    const first = transport.clientFor(nullBandwidthSink);
    const firstDispatcher = dispatcherFactory(first)(target());
    const second = transport.clientFor(nullBandwidthSink);
    const secondDispatcher = dispatcherFactory(second)(target());

    expect(secondDispatcher).toBe(firstDispatcher);
    expect(ProxyAgent).toHaveBeenCalledTimes(1);

    await transport.close();
    await transport.close();

    const direct = vi.mocked(Agent).mock.results[0]?.value as { close: ReturnType<typeof vi.fn> };
    const proxy = vi.mocked(ProxyAgent).mock.results[0]?.value as {
      close: ReturnType<typeof vi.fn>;
    };
    expect(direct.close).toHaveBeenCalledTimes(1);
    expect(proxy.close).toHaveBeenCalledTimes(1);
    expect(() => transport.clientFor(nullBandwidthSink)).toThrow(/already closed/);
  });

  it('logs close failures with only the credential-free proxy id', async () => {
    const closeError = new Error('close failed');
    vi.mocked(ProxyAgent).mockImplementationOnce(
      () =>
        ({
          compose() {
            return this;
          },
          close: () => Promise.reject(closeError),
        }) as never,
    );
    const warn = vi.fn();
    const config = loadConfig({ env: {}, dotenv: false });
    const transport = createManagedHttpTransport(config, { ...nullLogger, warn });
    const credentialed = target({
      username: 'secret-user',
      password: 'secret-password',
      url: 'http://secret-user:secret-password@proxy.example.net:8080',
    });

    dispatcherFactory(transport.clientFor(nullBandwidthSink))(credentialed);
    await expect(transport.close()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ proxy_id: 'http://proxy.example.net:8080' }),
      'could not close HTTP dispatcher',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret-user|secret-password/);
  });
});

describe('createProxySupply', () => {
  const sourceEnv = { PROXY_SOURCE_URL: 'https://example.net/proxies.txt' };

  it('aims the supply at the concurrency the run will actually use', () => {
    const config = loadConfig({ env: { ...sourceEnv, SCRAPER_CONCURRENCY: '10' }, dotenv: false });

    // The overriding value, not the configured one: a run started at
    // `--concurrency 100` needs a pool sized for 100. The two were separately
    // configured before, and a 5x disagreement went unnoticed for as long as it
    // existed.
    const supply = createProxySupply(config, nullLogger, undefined, 100);

    expect(supply.source?.getStats().targetCapacity).toBe(100);
    supply.source?.stop();
  });

  it('lets an explicit target capacity override the concurrency', () => {
    const config = loadConfig({
      env: { ...sourceEnv, SCRAPER_CONCURRENCY: '10', PROXY_SOURCE_TARGET_CAPACITY: '64' },
      dotenv: false,
    });

    const supply = createProxySupply(config, nullLogger, undefined, 10);

    expect(supply.source?.getStats().targetCapacity).toBe(64);
    supply.source?.stop();
  });

  it('builds no source at all when none is configured', () => {
    const config = loadConfig({ env: {}, dotenv: false });

    expect(createProxySupply(config, nullLogger).source).toBeNull();
  });
});

describe('buildRunner bandwidth lifetime', () => {
  it('creates a distinct bandwidth aggregator for every runner', async () => {
    const config = loadConfig({ env: { METRICS_BANDWIDTH: 'true' }, dotenv: false });
    const first = await buildComposedRunner({
      config,
      logger: nullLogger,
      sink: new MemorySnapshotSink(),
    });
    const second = await buildComposedRunner({
      config,
      logger: nullLogger,
      sink: new MemorySnapshotSink(),
    });

    expect(first.bandwidth).not.toBeNull();
    expect(second.bandwidth).not.toBeNull();
    expect(first.bandwidth).not.toBe(second.bandwidth);
  });
});

function stubResponse(): HttpResponse {
  return {
    url: 'https://www.tiktok.com/embed/v2/1',
    status: 200,
    statusText: 'OK',
    headers: {},
    body: '',
    redirected: false,
    durationMs: 1,
  };
}

const stressRecord: InputRecord = {
  raw_url: 'https://www.tiktok.com/@creator/video/7420000000000000001',
  url: 'https://www.tiktok.com/@creator/video/7420000000000000001',
  platform: 'tiktok',
  position: 1,
};

describe('buildRunner transport override', () => {
  it('is unused when no transport override is supplied (production path unchanged)', async () => {
    const config = loadConfig({ env: {}, dotenv: false });

    const built = await buildComposedRunner({
      config,
      logger: nullLogger,
      sink: new MemorySnapshotSink(),
    });

    expect(built.runner).toBeDefined();
    expect(ProxyAgent).not.toHaveBeenCalled();
  });

  it('routes every request through a supplied transport instead of FetchHttpClient', async () => {
    const config = loadConfig({ env: {}, dotenv: false });
    const request = vi.fn<HttpClient['request']>().mockResolvedValue(stubResponse());

    const built = await buildComposedRunner({
      config,
      logger: nullLogger,
      sink: new MemorySnapshotSink(),
      transport: () => ({ request }),
    });

    await built.runner.run([stressRecord]);

    expect(request).toHaveBeenCalled();
    // No proxies are configured in this test, but a supplied transport should
    // still mean FetchHttpClient/createProxyAgentFactory are never built at
    // all -- ProxyAgent must stay uninstantiated either way.
    expect(ProxyAgent).not.toHaveBeenCalled();
  });

  it("gives the transport factory the run's real bandwidth sink", async () => {
    const config = loadConfig({ env: { METRICS_BANDWIDTH: 'true' }, dotenv: false });
    let capturedSink: BandwidthSink | undefined;

    const built = await buildComposedRunner({
      config,
      logger: nullLogger,
      sink: new MemorySnapshotSink(),
      transport: (sink) => {
        capturedSink = sink;
        return { request: vi.fn<HttpClient['request']>().mockResolvedValue(stubResponse()) };
      },
    });

    expect(capturedSink).toBeDefined();
    capturedSink?.record({
      proxyId: null,
      host: 'example.test',
      requestBytes: 10,
      responseBytes: 20,
    });

    expect(built.bandwidth?.view().totalBytes).toBe(30);
  });

  it('never invokes the transport factory when metrics bandwidth is off', async () => {
    const config = loadConfig({ env: { METRICS_BANDWIDTH: 'false' }, dotenv: false });
    let capturedSink: BandwidthSink | undefined;

    await buildComposedRunner({
      config,
      logger: nullLogger,
      sink: new MemorySnapshotSink(),
      transport: (sink) => {
        capturedSink = sink;
        return { request: vi.fn<HttpClient['request']>().mockResolvedValue(stubResponse()) };
      },
    });

    expect(capturedSink).toBe(nullBandwidthSink);
  });
});
