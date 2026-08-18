import { describe, expect, it } from 'vitest';

import { loadConfig, redactConfig } from '../../src/config/env.js';

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
    expect(config.requestTimeoutMs).toBe(15_000);
    expect(config.attemptTimeoutMsByPlatform).toEqual({
      tiktok: 15_000,
      instagram: 60_000,
    });
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
      SCRAPER_REQUEST_TIMEOUT_MS: '12000',
      TIKTOK_ATTEMPT_TIMEOUT_MS: '18000',
      INSTAGRAM_ATTEMPT_TIMEOUT_MS: '75000',
    });

    expect(config.concurrency).toBe(25);
    expect(config.retry.maxAttempts).toBe(5);
    expect(config.retry.jitter).toBe(false);
    expect(config.outputDir).toBe('/tmp/snapshots');
    expect(config.instagram.clipsMaxPages).toBe(3);
    expect(config.instagram.clipsMaxAuthors).toBe(2);
    expect(config.requestTimeoutMs).toBe(12_000);
    expect(config.attemptTimeoutMsByPlatform).toEqual({
      tiktok: 18_000,
      instagram: 75_000,
    });
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
    expect(() => load({ TIKTOK_ATTEMPT_TIMEOUT_MS: '0' })).toThrow(/invalid configuration/);
    expect(() => load({ INSTAGRAM_ATTEMPT_TIMEOUT_MS: '-1' })).toThrow(/invalid configuration/);
    expect(() => load({ INSTAGRAM_ATTEMPT_TIMEOUT_MS: '1.5' })).toThrow(
      /INSTAGRAM_ATTEMPT_TIMEOUT_MS/,
    );
  });

  it('rejects a max delay below the initial delay', () => {
    expect(() => load({ RETRY_INITIAL_DELAY_MS: '5000', RETRY_MAX_DELAY_MS: '1000' })).toThrow(
      /RETRY_MAX_DELAY_MS/,
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
    expect(redactConfig(config)['proxy']).toEqual({ configured: 2 });
  });
});
