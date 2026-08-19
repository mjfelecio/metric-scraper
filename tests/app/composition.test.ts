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

import { createProxyAgentFactory } from '../../src/app/composition.js';
import { loadConfig } from '../../src/config/env.js';
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

    expect(ProxyAgent).toHaveBeenCalledWith(
      expect.objectContaining({ connectTimeout: 3000 }),
    );
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
