import { describe, expect, it } from 'vitest';

import { createProxyProvider, createProxySupply } from '../../src/app/composition.js';
import { loadConfig } from '../../src/config/env.js';
import { nullLogger, type Logger } from '../../src/core/logging/logger.js';
import { RotatingResidentialProxyProvider } from '../../src/infrastructure/proxy/rotating-residential-proxy-provider.js';
import { StaticProxyProvider } from '../../src/infrastructure/proxy/static-proxy-provider.js';

const RESIDENTIAL_ENV = {
  PROXY_MODE: 'rotating-residential',
  RESIDENTIAL_PROXY_HOST: 'gate.residential.example.net',
  RESIDENTIAL_PROXY_PORT: '7000',
  RESIDENTIAL_PROXY_USERNAME: 'account-1',
  RESIDENTIAL_PROXY_PASSWORD: 'secret',
};

function load(env: Record<string, string>) {
  return loadConfig({ env, dotenv: false });
}

/** A logger that keeps the warnings, so "ignored" can be asserted rather than assumed. */
function capturingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  const logger = {
    ...nullLogger,
    warn: (first: unknown, second?: unknown) => {
      warnings.push(typeof first === 'string' ? first : String(second));
    },
  } as unknown as Logger;
  return { logger, warnings };
}

describe('createProxyProvider', () => {
  it('defaults to the static pool when PROXY_MODE is unset', () => {
    // The whole point of the default: an existing .env with no PROXY_MODE in it
    // keeps behaving exactly as it did.
    const provider = createProxyProvider(load({}), nullLogger);

    expect(provider).toBeInstanceOf(StaticProxyProvider);
    expect(provider.mode).toBe('static');
  });

  it('builds the residential gateway for PROXY_MODE=rotating-residential', () => {
    const provider = createProxyProvider(load(RESIDENTIAL_ENV), nullLogger);

    expect(provider).toBeInstanceOf(RotatingResidentialProxyProvider);
    expect(provider.getStats().perProxy[0]?.id).toBe('http://gate.residential.example.net:7000');
  });

  it('rejects a mode it does not implement', () => {
    expect(() => load({ PROXY_MODE: 'residential' })).toThrow(/PROXY_MODE|proxy\.mode/);
  });

  it('never wires a candidate source in residential mode', () => {
    // The source exists to keep a roster stocked. A gateway has no roster, and
    // starting the refresh loop anyway would spend real requests on nothing.
    const config = load({ ...RESIDENTIAL_ENV, PROXY_SOURCE_URL: 'https://example.net/p.txt' });

    const supply = createProxySupply(config, nullLogger);

    expect(supply.source).toBeNull();
    expect(supply.provider.mode).toBe('rotating-residential');
  });

  it('warns rather than fails when static settings are left set in residential mode', () => {
    // Failing here would make the two modes awkward to compare: whoever is
    // switching between them has both sets of settings in one .env.
    const { logger, warnings } = capturingLogger();
    const config = load({
      ...RESIDENTIAL_ENV,
      PROXY_POOL: 'http://proxy-a.example.net:8000',
      PROXY_SOURCE_URL: 'https://example.net/p.txt',
    });

    const provider = createProxyProvider(config, logger);

    expect(provider.mode).toBe('rotating-residential');
    expect(warnings.join(' ')).toMatch(/PROXY_POOL/);
    expect(warnings.join(' ')).toMatch(/PROXY_SOURCE_URL/);
  });

  it('does not consult residential settings in static mode', () => {
    // A fully configured gateway sitting in the environment must not leak into
    // a static run: the pool is empty, so the requests go out directly.
    const config = load({ ...RESIDENTIAL_ENV, PROXY_MODE: 'static' });

    const provider = createProxyProvider(config, nullLogger);

    expect(provider.mode).toBe('static');
    expect(provider.getStats().configured).toBe(0);
  });
});

describe('proxy mode configuration isolation', () => {
  it('loads residential mode with no PROXY_POOL set', () => {
    const config = load(RESIDENTIAL_ENV);

    expect(config.proxy.pool).toBe('');
    expect(config.proxy.mode).toBe('rotating-residential');
  });

  it('loads static mode with no RESIDENTIAL_PROXY_* set', () => {
    const config = load({ PROXY_POOL: 'http://proxy-a.example.net:8000' });

    expect(config.proxy.residential.host).toBe('');
    expect(config.proxy.mode).toBe('static');
  });

  it.each([
    ['RESIDENTIAL_PROXY_HOST'],
    ['RESIDENTIAL_PROXY_PORT'],
    ['RESIDENTIAL_PROXY_USERNAME'],
    ['RESIDENTIAL_PROXY_PASSWORD'],
  ])('fails at startup when %s is missing', (key) => {
    // Named rather than generic: a gateway missing one setting fails every job
    // in the run, and a batch of proxy_error rows is a poor way to find out.
    const env = { ...RESIDENTIAL_ENV };
    delete (env as Record<string, string>)[key];

    expect(() => load(env)).toThrow(new RegExp(key));
  });

  it('does not require any residential setting while the mode is static', () => {
    expect(() => load({ PROXY_MODE: 'static' })).not.toThrow();
    expect(() => load({})).not.toThrow();
  });
});
