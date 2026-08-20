import { describe, expect, it } from 'vitest';

import { loadConfig, redactConfig, resolveTargetCapacity } from '../../src/config/env.js';

function load(env: Record<string, string | undefined>) {
  return loadConfig({ env, dotenv: false });
}

describe('loadConfig', () => {
  it('runs on defaults with an empty environment', () => {
    const config = load({});
    expect(config.concurrency).toBe(10);
    expect(config.targetRpm).toBe(500);
    expect(config.retry.maxAttempts).toBe(3);
    expect(config.outputDir).toBe('./output');
    expect(config.proxy.pool).toBe('');
    expect(config.session.storePath).toBeNull();
    expect(config.instagram.clipsMaxPages).toBe(2);
    expect(config.instagram.clipsMaxAuthors).toBe(3);
  });

  it('reads overrides from the environment', () => {
    const config = load({
      SCRAPER_CONCURRENCY: '25',
      SCRAPER_TARGET_RPM: '500',
      RETRY_MAX_ATTEMPTS: '5',
      RETRY_JITTER: 'false',
      OUTPUT_DIR: '/tmp/snapshots',
      INSTAGRAM_CLIPS_MAX_PAGES: '3',
      INSTAGRAM_CLIPS_MAX_AUTHORS: '2',
    });

    expect(config.concurrency).toBe(25);
    expect(config.retry.maxAttempts).toBe(5);
    expect(config.retry.jitter).toBe(false);
    expect(config.outputDir).toBe('/tmp/snapshots');
    expect(config.instagram.clipsMaxPages).toBe(3);
    expect(config.instagram.clipsMaxAuthors).toBe(2);
  });

  it('treats an empty string as unset', () => {
    expect(load({ SCRAPER_CONCURRENCY: '', PROXY_POOL: '' }).concurrency).toBe(10);
  });

  it('accepts the documented boolean spellings', () => {
    for (const value of ['1', 'true', 'yes', 'on']) {
      expect(load({ RETRY_JITTER: value }).retry.jitter).toBe(true);
    }
    for (const value of ['0', 'false', 'no', 'off']) {
      expect(load({ RETRY_JITTER: value }).retry.jitter).toBe(false);
    }
  });

  it('rejects a non-numeric number', () => {
    expect(() => load({ SCRAPER_CONCURRENCY: 'ten' })).toThrow(/SCRAPER_CONCURRENCY/);
  });

  it('rejects a non-boolean boolean', () => {
    expect(() => load({ RETRY_JITTER: 'maybe' })).toThrow(/RETRY_JITTER/);
  });

  it('rejects out-of-range values', () => {
    expect(() => load({ SCRAPER_CONCURRENCY: '0' })).toThrow(/invalid configuration/);
    expect(() => load({ RETRY_MAX_ATTEMPTS: '0' })).toThrow(/invalid configuration/);
    expect(() => load({ INSTAGRAM_CLIPS_MAX_PAGES: '0' })).toThrow(/invalid configuration/);
    expect(() => load({ INSTAGRAM_CLIPS_MAX_AUTHORS: '0' })).toThrow(/invalid configuration/);
  });

  it('rejects a max delay below the initial delay', () => {
    expect(() => load({ RETRY_INITIAL_DELAY_MS: '5000', RETRY_MAX_DELAY_MS: '1000' })).toThrow(
      /RETRY_MAX_DELAY_MS/,
    );
  });

  it('reserves one lease in five for unproven proxies by default', () => {
    expect(load({}).proxy.explorationPeriod).toBe(5);
    expect(load({ PROXY_EXPLORATION_PERIOD: '10' }).proxy.explorationPeriod).toBe(10);
    // Zero is the switch-off value, not a validation error: it restores strict
    // preference for proxies that have already worked.
    expect(load({ PROXY_EXPLORATION_PERIOD: '0' }).proxy.explorationPeriod).toBe(0);
  });

  it('defaults the proxy connect timeout to 3000ms', () => {
    expect(load({}).proxy.connectTimeoutMs).toBe(3_000);
  });

  it('reads an override for the proxy connect timeout', () => {
    expect(load({ PROXY_CONNECT_TIMEOUT_MS: '1500' }).proxy.connectTimeoutMs).toBe(1_500);
  });

  it('rejects a proxy connect timeout at or above the request timeout', () => {
    expect(() =>
      load({ SCRAPER_REQUEST_TIMEOUT_MS: '5000', PROXY_CONNECT_TIMEOUT_MS: '5000' }),
    ).toThrow(/PROXY_CONNECT_TIMEOUT_MS/);
    expect(() =>
      load({ SCRAPER_REQUEST_TIMEOUT_MS: '5000', PROXY_CONNECT_TIMEOUT_MS: '6000' }),
    ).toThrow(/PROXY_CONNECT_TIMEOUT_MS/);
  });

  it('accepts a proxy connect timeout comfortably below the request timeout', () => {
    const config = load({ SCRAPER_REQUEST_TIMEOUT_MS: '15000', PROXY_CONNECT_TIMEOUT_MS: '3000' });
    expect(config.proxy.connectTimeoutMs).toBe(3_000);
  });

  it('rejects a validation budget that leaves nothing after the connect phase', () => {
    // Validation spends the connect budget reaching the proxy and still owes a
    // tunnel, a handshake and a round trip. Configure it at or below the
    // connect budget and every candidate fails at the next stage, so the pool
    // starves while the counters insist the probe is working.
    expect(() =>
      load({ PROXY_CONNECT_TIMEOUT_MS: '3000', PROXY_SOURCE_VALIDATE_TIMEOUT_MS: '3000' }),
    ).toThrow(/PROXY_SOURCE_VALIDATE_TIMEOUT_MS/);
    expect(() =>
      load({ PROXY_CONNECT_TIMEOUT_MS: '3000', PROXY_SOURCE_VALIDATE_TIMEOUT_MS: '2000' }),
    ).toThrow(/PROXY_SOURCE_VALIDATE_TIMEOUT_MS/);
  });

  it('accepts a validation budget with room for the stages after connect', () => {
    const config = load({
      PROXY_CONNECT_TIMEOUT_MS: '3000',
      PROXY_SOURCE_VALIDATE_TIMEOUT_MS: '5000',
    });
    expect(config.proxy.source.validateTimeoutMs).toBe(5_000);
  });
});

describe('loadConfig proxy supply', () => {
  it('defaults the supply target to following SCRAPER_CONCURRENCY', () => {
    const config = load({ SCRAPER_CONCURRENCY: '40' });

    // `0` is not "no target": it is "whatever the run is actually going to
    // use", which is the only setting under which the two cannot drift apart.
    expect(config.proxy.source.targetCapacity).toBe(0);
    expect(resolveTargetCapacity(config, 40)).toBe(40);
    expect(config.proxy.source.minCapacity).toBe(5);
    expect(config.proxy.acquireWaitMs).toBe(5_000);
  });

  it('lets an explicit target capacity win over the concurrency', () => {
    const config = load({ SCRAPER_CONCURRENCY: '10', PROXY_SOURCE_TARGET_CAPACITY: '64' });

    expect(resolveTargetCapacity(config, 10)).toBe(64);
  });

  it('follows the concurrency a run was actually started with', () => {
    const config = load({ SCRAPER_CONCURRENCY: '10' });

    // A run started at `--concurrency 100` needs a pool sized for 100, not for
    // whatever the config file happened to say.
    expect(resolveTargetCapacity(config, 100)).toBe(100);
  });

  it('refuses the settings it replaced rather than reading them in a new unit', () => {
    // These were denominated in proxies; their replacements are slots, so the
    // same number means something several times larger. Reading it silently is
    // the exact unit error this pair of settings caused to begin with.
    expect(() => load({ PROXY_SOURCE_DESIRED_ACTIVE: '20' })).toThrow(
      /PROXY_SOURCE_DESIRED_ACTIVE .*PROXY_SOURCE_TARGET_CAPACITY/,
    );
    expect(() => load({ PROXY_SOURCE_MIN_HEALTHY: '5' })).toThrow(
      /PROXY_SOURCE_MIN_HEALTHY .*PROXY_SOURCE_MIN_CAPACITY/,
    );
  });

  it('ignores a retired setting that is present but empty', () => {
    // An empty value is how every other setting in this file says "unset".
    expect(() => load({ PROXY_SOURCE_DESIRED_ACTIVE: '' })).not.toThrow();
  });
});

describe('METRICS_BANDWIDTH', () => {
  it('defaults to true so the dashboard panel is populated', () => {
    expect(load({}).metricsBandwidth).toBe(true);
  });

  it('can be switched off', () => {
    expect(load({ METRICS_BANDWIDTH: 'false' }).metricsBandwidth).toBe(false);
  });

  it('rejects a non-boolean value rather than guessing', () => {
    expect(() => load({ METRICS_BANDWIDTH: 'sometimes' })).toThrow(
      /METRICS_BANDWIDTH must be a boolean/,
    );
  });
});

describe('redactConfig', () => {
  it('never exposes proxy credentials', () => {
    const config = load({
      PROXY_POOL:
        'http://user:secret@proxy-a.example.net:8000,http://user:secret@proxy-b.example.net:8000',
    });
    const redacted = JSON.stringify(redactConfig(config));

    expect(redacted).not.toContain('secret');
    expect(redacted).not.toContain('proxy-a.example.net');
    expect(redactConfig(config)['proxy']).toEqual({ configured: 2, source: null });
  });

  it('reports the supply target it resolved, not the raw setting', () => {
    const config = load({
      PROXY_SOURCE_URL: 'https://example.net/proxies.txt',
      SCRAPER_CONCURRENCY: '32',
    });

    expect(redactConfig(config)['proxy']).toEqual({
      configured: 0,
      source: { target_capacity: 32 },
    });
  });
});
