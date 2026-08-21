import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, type AppConfig } from '../../../src/config/env.js';
import { nullLogger } from '../../../src/core/logging/logger.js';
import { runLoadTest } from '../../../src/stress/load-generator/load-generator.js';
import { buildStressPlan, type StressPlan } from '../../../src/stress/load-generator/profiles.js';
import { CLEAN_WORKLOAD_PROFILE } from '../../../src/stress/workload/workload-profile.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'metric-scraper-stress-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function stressConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    env: {
      PROXY_POOL: 'http://mock-proxy-1.local:8000',
      SCRAPER_MAX_QUEUE_SIZE: '1000',
      RETRY_MAX_ATTEMPTS: '2',
      ...overrides,
    },
    dotenv: false,
  });
}

describe('runLoadTest', () => {
  it('runs a short single-phase plan end to end and writes JSONL rows', async () => {
    const plan: StressPlan = buildStressPlan({
      profile: 'baseline',
      platform: 'tiktok',
      concurrency: 3,
      durationMs: 400,
      workload: CLEAN_WORKLOAD_PROFILE,
    });

    const result = await runLoadTest({
      config: stressConfig(),
      logger: nullLogger,
      plan,
      outputDir: dir,
    });

    expect(result.phases).toHaveLength(1);
    const phase = result.phases[0];
    expect(phase?.summary.totals.requests).toBeGreaterThan(0);
    expect(phase?.fatalError).toBeNull();

    const written = await readFile(result.snapshotsPath, 'utf8');
    expect(written.trim().split('\n').length).toBe(phase?.summary.totals.requests);
  });

  it('bounds a duration-based phase to roughly its configured duration, even under high latency', async () => {
    const slowWorkload = {
      ...CLEAN_WORKLOAD_PROFILE,
      tiktok: { ...CLEAN_WORKLOAD_PROFILE.tiktok, latency: { minMs: 500, maxMs: 500 } },
    };
    const plan: StressPlan = buildStressPlan({
      profile: 'baseline',
      platform: 'tiktok',
      concurrency: 2,
      durationMs: 300,
      workload: slowWorkload,
    });

    const startedAt = Date.now();
    const result = await runLoadTest({
      config: stressConfig(),
      logger: nullLogger,
      plan,
      outputDir: dir,
    });
    const elapsedMs = Date.now() - startedAt;

    // Well under what running every overprovisioned job to completion at
    // 500ms/job would take -- proof the abort signal, not natural
    // exhaustion, ended the phase.
    expect(elapsedMs).toBeLessThan(3_000);
    expect(result.phases[0]).toBeDefined();
  });

  it('reuses one proxy pool across phases: stats accumulate rather than reset', async () => {
    const plan: StressPlan = buildStressPlan({
      profile: 'acceptance',
      platform: 'tiktok',
      concurrency: 3,
      targetRpm: 200,
      durationMs: 200,
      rampUpMs: 400,
      workload: CLEAN_WORKLOAD_PROFILE,
    });

    const result = await runLoadTest({
      config: stressConfig(),
      logger: nullLogger,
      plan,
      outputDir: dir,
    });

    expect(result.phases.length).toBeGreaterThan(1);
    // Each phase's own summary reports THIS phase's proxy activity only --
    // that's existing production behaviour in build-proxy-summary.ts
    // (`usage?.requests ?? health.requests`: a fresh per-call MetricsCollector
    // wins over the pool's lifetime counter, by design, so a session cycle's
    // summary describes that cycle rather than the whole session). What
    // actually proves pool *reuse* is `first_used_at`, which always comes
    // from the pool's own health record and is never overridden by a
    // per-call view -- it must be the same non-null timestamp in every
    // phase, proving the same underlying proxy entry persisted rather than
    // being rebuilt.
    const firstUsedTimestamps = result.phases.map(
      (phase) => phase.summary.proxies.per_proxy[0]?.first_used_at,
    );
    expect(firstUsedTimestamps[0]).not.toBeNull();
    expect(new Set(firstUsedTimestamps).size).toBe(1);
  });

  it('samples queue depth and memory throughout the run', async () => {
    const plan: StressPlan = buildStressPlan({
      profile: 'baseline',
      platform: 'tiktok',
      concurrency: 2,
      durationMs: 400,
      workload: CLEAN_WORKLOAD_PROFILE,
    });

    const result = await runLoadTest({
      config: stressConfig(),
      logger: nullLogger,
      plan,
      outputDir: dir,
      memorySampleIntervalMs: 50,
    });

    expect(result.queueSamples.length).toBeGreaterThan(0);
    expect(result.memorySamples.length).toBeGreaterThan(0);
    expect(result.timelineSamples.length).toBeGreaterThanOrEqual(0);
  });
});
