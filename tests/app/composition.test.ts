import { describe, expect, it, vi } from 'vitest';

import type * as Undici from 'undici';

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof Undici>();
  return {
    ...actual,
    ProxyAgent: vi.fn().mockImplementation((options: unknown) => ({ __options: options })),
  };
});

import { ProxyAgent } from 'undici';

import { createProxyAgentFactory, createProxySupply } from '../../src/app/composition.js';
import { loadConfig } from '../../src/config/env.js';
import { nullLogger } from '../../src/core/logging/logger.js';
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
    const factory = createProxyAgentFactory(config);

    factory(target());

    expect(ProxyAgent).toHaveBeenCalledWith({
      uri: 'http://proxy.example.net:8080',
      connectTimeout: 2500,
    });
  });

  it('defaults to 3000ms when PROXY_CONNECT_TIMEOUT_MS is unset', () => {
    const config = loadConfig({ env: {}, dotenv: false });
    const factory = createProxyAgentFactory(config);

    factory(target());

    expect(ProxyAgent).toHaveBeenCalledWith(expect.objectContaining({ connectTimeout: 3000 }));
  });

  it('reuses one agent per distinct proxy URL rather than building a new one per call', () => {
    const config = loadConfig({ env: {}, dotenv: false });
    const factory = createProxyAgentFactory(config);

    const first = factory(target());
    const second = factory(target());

    expect(first).toBe(second);
    expect(ProxyAgent).toHaveBeenCalledTimes(1);
  });

  it('builds a separate agent for a different proxy URL', () => {
    const config = loadConfig({ env: {}, dotenv: false });
    const factory = createProxyAgentFactory(config);

    factory(target({ url: 'http://a.example.net:8080', host: 'a.example.net' }));
    factory(target({ url: 'http://b.example.net:8080', host: 'b.example.net' }));

    expect(ProxyAgent).toHaveBeenCalledTimes(2);
  });

  it('refuses a proxy protocol the fetch transport cannot dispatch through', () => {
    const config = loadConfig({ env: {}, dotenv: false });
    const factory = createProxyAgentFactory(config);

    expect(() => factory(target({ protocol: 'socks5' }))).toThrow(/socks5/);
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
