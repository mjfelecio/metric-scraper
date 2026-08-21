import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runSession } from '../../src/app/scrape-session.js';
import { loadConfig, type AppConfig } from '../../src/config/env.js';
import { nullLogger } from '../../src/core/logging/logger.js';
import { BandwidthAggregator } from '../../src/core/metrics/bandwidth.js';
import { MetricsCollector } from '../../src/core/metrics/metrics-collector.js';
import { type InputRecord } from '../../src/core/models/input.js';
import { type Platform } from '../../src/core/models/platform.js';
import {
  scrapeFailure,
  scrapeSuccess,
  type ScrapeResult,
} from '../../src/core/models/scrape-result.js';
import { EMPTY_VIDEO_DATA } from '../../src/core/models/snapshot.js';
import { type SnapshotSink } from '../../src/core/output/snapshot-sink.js';
import { RetryPolicy } from '../../src/core/retry/retry-policy.js';
import { ScrapeRunner } from '../../src/core/runner/scrape-runner.js';
import { type HttpClient } from '../../src/core/scraper/http-port.js';
import { createScraperRegistry, type Scraper } from '../../src/core/scraper/scraper.js';
import { resolveSessionPaths } from '../../src/infrastructure/output/run-paths.js';
import { NullProxyPool } from '../../src/infrastructure/proxy/in-memory-proxy-pool.js';
import { StaticProxyProvider } from '../../src/infrastructure/proxy/static-proxy-provider.js';
import { NullSessionPool } from '../../src/infrastructure/session/in-memory-session-pool.js';
import { createDefaultUrlNormalizerRegistry } from '../../src/platforms/index.js';

const unusedHttp: HttpClient = {
  request: () => Promise.reject(new Error('these fakes never touch the network')),
};

function records(...urls: string[]): InputRecord[] {
  return urls.map((url, index) => ({
    raw_url: url,
    url,
    platform: 'tiktok',
    position: index + 1,
  }));
}

class ScriptedScraper implements Scraper {
  readonly platform: Platform = 'tiktok';
  constructor(private readonly behaviour: (url: string, attempt: number) => ScrapeResult) {}
  scrape(url: string, context: { attempt: number }): Promise<ScrapeResult> {
    return Promise.resolve(this.behaviour(url, context.attempt));
  }
}

let dir: string;
let config: AppConfig;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'session-test-'));
  config = loadConfig({ dotenv: false, env: { OUTPUT_DIR: dir, LOG_LEVEL: 'silent' } });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function paths(): ReturnType<typeof resolveSessionPaths> {
  return resolveSessionPaths({
    outputDir: dir,
    platform: 'tiktok',
    startedAt: new Date('2026-08-18T00:00:00.000Z'),
  });
}

/** Builds a real `ScrapeRunner` over a scripted scraper — no network, no clock. */
function runnerFactory(options: {
  scraper: Scraper;
  onCycle?: (cycle: number) => void;
  maxAttempts?: number;
}) {
  return async (context: { cycle: number; sink: SnapshotSink }) => {
    options.onCycle?.(context.cycle);
    const metrics = new MetricsCollector();
    return Promise.resolve({
      runner: new ScrapeRunner({
        scrapers: createScraperRegistry([options.scraper]),
        http: unusedHttp,
        proxyProvider: new StaticProxyProvider(new NullProxyPool()),
        sessionPool: new NullSessionPool(),
        sink: context.sink,
        metrics,
        retryPolicy: new RetryPolicy({ maxAttempts: options.maxAttempts ?? 1, jitter: false }),
        logger: nullLogger,
        config: {
          concurrency: 4,
          targetRpm: 0,
          maxQueueSize: 0,
          attemptTimeoutMsByPlatform: { tiktok: 5_000, instagram: 20_000 },
        },
        sleep: () => Promise.resolve(),
      }),
      metrics,
      proxyProvider: new StaticProxyProvider(new NullProxyPool()),
      sessionPool: new NullSessionPool(),
      normalizers: createDefaultUrlNormalizerRegistry(),
      concurrency: 4,
      targetRpm: 0,
      bandwidth: null,
    });
  };
}

const okScraper = new ScriptedScraper(() => scrapeSuccess({ ...EMPTY_VIDEO_DATA, views: 1 }));

async function session(overrides: Partial<Parameters<typeof runSession>[0]> = {}) {
  const batch = records('https://www.tiktok.com/@a/video/1', 'https://www.tiktok.com/@a/video/2');
  return runSession({
    records: batch,
    platform: 'tiktok',
    counts: { candidates: batch.length, accepted: batch.length, rejected: 0 },
    config,
    logger: nullLogger,
    paths: paths(),
    schedule: { intervalMs: 0, durationMs: null, maxCycles: 3 },
    sampleIntervalMs: 5,
    createRunner: runnerFactory({ scraper: okScraper }),
    ...overrides,
  });
}

describe('runSession', () => {
  it('appends every cycle to one session file', async () => {
    const summary = await session();

    const rows = (await readFile(paths().snapshots, 'utf8')).trim().split('\n');
    // Three cycles over a two-URL batch, all in one append-only file.
    expect(rows).toHaveLength(6);
    expect(summary.output.rows_written).toBe(6);
    expect(summary.totals.requests).toBe(6);
    expect(summary.totals.successes).toBe(6);
    expect(summary.totals.success_rate).toBe(1);
  });

  it('writes one summary per cycle plus the session summary', async () => {
    await session();

    const cycleFiles = (await readdir(paths().cyclesDir)).sort();
    expect(cycleFiles).toEqual([
      'tiktok-2026-08-18T00-00-00-000Z.cycle-001.json',
      'tiktok-2026-08-18T00-00-00-000Z.cycle-002.json',
      'tiktok-2026-08-18T00-00-00-000Z.cycle-003.json',
    ]);

    const persisted = JSON.parse(await readFile(paths().summary, 'utf8')) as {
      totals: { requests: number };
    };
    expect(persisted.totals.requests).toBe(6);
  });

  it('keeps going when a cycle throws, and records why', async () => {
    let built = 0;
    const summary = await session({
      createRunner: async (context: { cycle: number; sink: SnapshotSink }) => {
        built += 1;
        if (context.cycle === 2) {
          throw new Error('cycle 2 exploded');
        }
        return runnerFactory({ scraper: okScraper })(context);
      },
    });

    // The decisive assertion: a mid-session failure did not end the session.
    expect(built).toBe(3);
    expect(summary.cycles.started).toBe(3);
    expect(summary.cycles.completed).toBe(2);
    expect(summary.cycles.failed).toBe(1);
    // Cycles 1 and 3 still produced their rows.
    expect(summary.totals.requests).toBe(4);
    expect(summary.schedule.stop_reason).toBe('max_cycles');
  });

  it('forwards every result with the cycle it belongs to', async () => {
    const seen: { cycle: number; url: string; views: number | null }[] = [];

    const summary = await session({
      onResult: (event, context) => {
        seen.push({
          cycle: context.cycle,
          url: event.snapshot.url,
          views: event.snapshot.views,
        });
      },
    });

    // Three cycles over a two-URL batch: one event per finished URL, each
    // carrying the snapshot the runner already wrote out.
    expect(seen).toHaveLength(6);
    expect(seen.map((entry) => entry.cycle).sort()).toEqual([1, 1, 2, 2, 3, 3]);
    expect(seen.every((entry) => entry.views === 1)).toBe(true);

    // The counters the session already kept are untouched by the new hook.
    expect(summary.totals.requests).toBe(6);
    expect(summary.totals.successes).toBe(6);
  });

  it('counts retries apart from requests so throughput cannot be inflated', async () => {
    // Fails once per URL, then succeeds: 2 URLs x 3 cycles = 6 requests, 6 retries.
    const flaky = new ScriptedScraper((_url, attempt) =>
      attempt === 1
        ? scrapeFailure('error', { code: 'network_error', message: 'flaky', retryable: true })
        : scrapeSuccess({ ...EMPTY_VIDEO_DATA, views: 1 }),
    );

    const summary = await session({
      createRunner: runnerFactory({ scraper: flaky, maxAttempts: 2 }),
    });

    expect(summary.totals.requests).toBe(6);
    expect(summary.totals.successes).toBe(6);
    expect(summary.retries.total_retries).toBe(6);
    expect(summary.retries.retried_requests).toBe(6);
  });

  it('stops when cancelled and still reports', async () => {
    const controller = new AbortController();
    const summary = await session({
      schedule: { intervalMs: 0, durationMs: null, maxCycles: null },
      signal: controller.signal,
      onCycleEnd: () => {
        controller.abort();
      },
    });

    expect(summary.schedule.stop_reason).toBe('cancelled');
    expect(summary.cycles.started).toBe(1);
    // The run still finished and reported rather than throwing away its work.
    expect(summary.totals.requests).toBe(2);
    expect(summary.finished_at).not.toBe('');
  });

  it('reports both wall-clock and active throughput', async () => {
    const summary = await session();

    expect(summary.throughput.wall_clock_rpm).toBeGreaterThan(0);
    expect(summary.throughput.active_rpm).toBeGreaterThan(0);
    // Idle time is only ever excluded, never invented.
    expect(summary.throughput.active_rpm).toBeGreaterThanOrEqual(
      summary.throughput.wall_clock_rpm - 1e-9,
    );
  });

  it('accumulates bandwidth across cycle boundaries without double-counting or losing bytes', async () => {
    // `buildRunner` mints a fresh `BandwidthAggregator` per cycle in real usage
    // (see composition.ts); distinct, deliberately non-uniform totals per
    // cycle so a double-count or a dropped cycle lands on a total no correct
    // implementation would produce.
    const cycleBytes = [100, 200, 400];
    const foldedTotals: number[] = [];

    const summary = await session({
      onBandwidthFold: (totalBytes) => foldedTotals.push(totalBytes),
      createRunner: async (context) => {
        const built = await runnerFactory({ scraper: okScraper })(context);
        const bandwidth = new BandwidthAggregator();
        const bytes = cycleBytes[context.cycle - 1] ?? 0;
        bandwidth.record({
          proxyId: null,
          host: 'example.com',
          requestBytes: 0,
          responseBytes: bytes,
        });
        return { ...built, bandwidth };
      },
    });

    expect(summary.cycles.started).toBe(3);
    // Observed synchronously at every boundary, so this cannot depend on a
    // real 5 ms timer landing inside a tiny handoff window.
    expect(foldedTotals).toEqual([100, 300, 700]);
  });
});
