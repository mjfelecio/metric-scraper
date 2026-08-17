import { randomUUID } from 'node:crypto';

import {
  PQueueTaskQueue,
  type TaskQueue,
  type TaskQueueOptions,
} from '../concurrency/task-queue.js';
import { type Logger } from '../logging/logger.js';
import { type MetricsCollector } from '../metrics/metrics-collector.js';
import { ScrapeError, type ScrapeErrorInfo } from '../models/errors.js';
import { type InputRecord } from '../models/input.js';
import { type Platform } from '../models/platform.js';
import { type RunSummary } from '../models/run-summary.js';
import { type ScrapeResult } from '../models/scrape-result.js';
import {
  createFailureSnapshot,
  createSuccessSnapshot,
  type MetricSnapshot,
} from '../models/snapshot.js';
import { type FailureStatus } from '../models/status.js';
import { type SnapshotSink } from '../output/snapshot-sink.js';
import { realSleep, type Sleep } from '../retry/sleep.js';
import { type RetryPolicy } from '../retry/retry-policy.js';
import { type HttpClient } from '../scraper/http-port.js';
import { type ProxyLease, type SessionLease } from '../scraper/lease-ports.js';
import { type ProxyPool, type SessionPool } from '../scraper/pool-ports.js';
import { type ScraperRegistry } from '../scraper/scraper.js';

import { buildRunSummary } from './build-summary.js';
import { type JobCompletedEvent, type RunCounts, type RunProgress } from './types.js';

export interface ScrapeRunnerConfig {
  concurrency: number;
  targetRpm: number;
  maxQueueSize: number;
  requestTimeoutMs: number;
}

export interface ScrapeRunnerDeps {
  scrapers: ScraperRegistry;
  http: HttpClient;
  proxyPool: ProxyPool;
  sessionPool: SessionPool;
  sink: SnapshotSink;
  metrics: MetricsCollector;
  retryPolicy: RetryPolicy;
  logger: Logger;
  config: ScrapeRunnerConfig;
  /** Overridable for tests. */
  createQueue?: ((options: TaskQueueOptions) => TaskQueue) | undefined;
  sleep?: Sleep | undefined;
  now?: (() => Date) | undefined;
}

export interface RunOptions {
  runId?: string | undefined;
  /** Recorded in the summary; `null` when the batch mixes platforms. */
  platform?: Platform | null | undefined;
  /** Input statistics from the loader, so rejected URLs show up in the summary. */
  counts?: Partial<RunCounts> | undefined;
  signal?: AbortSignal | undefined;
  summaryPath?: string | null | undefined;
  onResult?: ((event: JobCompletedEvent) => void) | undefined;
  onProgress?: ((progress: RunProgress) => void) | undefined;
}

export interface RunResult {
  runId: string;
  summary: RunSummary;
  /** Set when the run stopped early (output failure or cancellation). */
  fatalError: ScrapeError | null;
}

/**
 * Orchestrates a batch: schedules work, applies the retry policy, leases
 * proxies and sessions, turns every outcome into a row, and reports metrics.
 *
 * It knows nothing about TikTok or Instagram. Platform behaviour reaches it
 * only through `ScraperRegistry`, which is what allows platform work to land
 * later without touching this file.
 */
export class ScrapeRunner {
  private readonly deps: ScrapeRunnerDeps;
  private readonly sleep: Sleep;
  private readonly now: () => Date;

  constructor(deps: ScrapeRunnerDeps) {
    this.deps = deps;
    this.sleep = deps.sleep ?? realSleep;
    this.now = deps.now ?? (() => new Date());
  }

  async run(records: readonly InputRecord[], options: RunOptions = {}): Promise<RunResult> {
    const { config, logger, metrics, sink } = this.deps;
    const runId = options.runId ?? randomUUID();
    const runLogger = logger.child({ run_id: runId });

    const controller = new AbortController();
    const signal =
      options.signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, options.signal]);

    const queue =
      this.deps.createQueue?.({
        concurrency: config.concurrency,
        targetRpm: config.targetRpm,
        maxQueueSize: config.maxQueueSize,
      }) ??
      new PQueueTaskQueue({
        concurrency: config.concurrency,
        targetRpm: config.targetRpm,
        maxQueueSize: config.maxQueueSize,
      });

    const startedAt = this.now();
    metrics.start();
    runLogger.info(
      {
        urls: records.length,
        concurrency: config.concurrency,
        target_rpm: config.targetRpm,
      },
      'run started',
    );

    let fatalError: ScrapeError | null = null;
    let processed = 0;

    const emitProgress = (): void => {
      if (options.onProgress === undefined) return;
      const view = metrics.view();
      options.onProgress({
        total: records.length,
        processed,
        successful: view.successfulRequests,
        failed: view.failedRequests,
        inFlight: queue.pending,
        queued: queue.size,
        elapsedMs: view.elapsedMs,
        throughputPerMinute: view.throughputPerMinute,
      });
    };

    const jobs = records.map((record) =>
      queue
        .add(async () => {
          if (signal.aborted) return;
          const event = await this.processRecord(record, signal, runLogger);

          try {
            await sink.write(event.snapshot);
          } catch (error) {
            // An unwritable output is a run-level failure, not a row-level one:
            // continuing would silently lose data.
            fatalError = new ScrapeError({
              code: 'output_error',
              message: `failed to write snapshot: ${error instanceof Error ? error.message : String(error)}`,
              cause: error,
            });
            queue.clear();
            controller.abort(fatalError);
            return;
          }

          processed += 1;
          metrics.recordResult({
            status: event.snapshot.status,
            latencyMs: event.snapshot.latency_ms,
            retries: event.retries,
            exhausted:
              event.snapshot.status !== 'ok' &&
              event.attempts >= this.deps.retryPolicy.options.maxAttempts,
            errorCode: extractErrorCode(event.snapshot.error),
            platformHttpRequests: event.platformHttpRequests,
          });

          options.onResult?.(event);
          emitProgress();
        })
        .catch((error: unknown) => {
          // Reaching here means the queue itself rejected (e.g. queue full).
          if (fatalError === null) {
            fatalError = ScrapeError.from(error);
            queue.clear();
            controller.abort(fatalError);
          }
        }),
    );

    await Promise.all(jobs);
    await queue.onIdle();

    metrics.finish();
    // Final tick, so observers see a settled state (nothing in flight, nothing
    // queued) rather than the mid-flight numbers from the last result.
    emitProgress();
    const finishedAt = this.now();

    try {
      await sink.close();
    } catch (error) {
      fatalError ??= new ScrapeError({
        code: 'output_error',
        message: `failed to close output: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
      });
    }

    const counts: RunCounts = {
      candidates: options.counts?.candidates ?? records.length,
      accepted: options.counts?.accepted ?? records.length,
      rejected: options.counts?.rejected ?? 0,
    };

    const summary = buildRunSummary({
      runId,
      platform: options.platform ?? inferPlatform(records),
      startedAt,
      finishedAt,
      counts,
      metrics: metrics.view(),
      proxyStats: this.deps.proxyPool.getStats(),
      sessionStats: this.deps.sessionPool.getStats(),
      concurrency: config.concurrency,
      targetRpm: config.targetRpm,
      snapshotsPath: sink.location,
      summaryPath: options.summaryPath ?? null,
      rowsWritten: sink.rowsWritten,
    });

    runLogger.info(
      {
        requests: summary.totals.requests,
        successes: summary.totals.successes,
        failures: summary.totals.failures,
        rpm: Math.round(summary.throughput.requests_per_minute),
      },
      'run finished',
    );

    return { runId, summary, fatalError };
  }

  /**
   * Runs one URL through the attempt chain. Always resolves with a row —
   * a failure is data, not an exception.
   */
  private async processRecord(
    record: InputRecord,
    signal: AbortSignal,
    logger: Logger,
  ): Promise<JobCompletedEvent> {
    const { metrics, retryPolicy, config } = this.deps;
    const jobLogger = logger.child({ url: record.url, platform: record.platform });
    const startedAtMs = Date.now();
    const scrapedAt = this.now();

    const scraper = this.deps.scrapers.get(record.platform);
    if (scraper === undefined) {
      const error: ScrapeErrorInfo = {
        code: 'unsupported_platform',
        message: `no scraper registered for platform "${record.platform}"`,
        retryable: false,
      };
      return {
        snapshot: createFailureSnapshot(
          { platform: record.platform, url: record.url, scrapedAt, latencyMs: 0 },
          'error',
          error,
        ),
        attempts: 0,
        retries: 0,
        proxyId: null,
        platformHttpRequests: 0,
      };
    }

    let attempt = 0;
    let retries = 0;
    let lastProxyId: string | null = null;
    let lastResult: ScrapeResult | null = null;
    let platformHttpRequests = 0;

    while (attempt < retryPolicy.options.maxAttempts) {
      attempt += 1;

      let proxyLease: ProxyLease | null = null;
      let sessionLease: SessionLease | null = null;
      let result: ScrapeResult;
      let attemptHttpRequests = 0;

      try {
        proxyLease = await this.deps.proxyPool.acquire(signal);
        sessionLease = await this.deps.sessionPool.acquire(
          record.platform,
          signal,
          proxyLease?.id ?? null,
        );
        lastProxyId = proxyLease?.id ?? null;

        // The attempt is bounded by both the run's lifetime and the per-request
        // timeout, so a hung platform response cannot stall the queue.
        const attemptSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(config.requestTimeoutMs),
        ]);

        result = await scraper.scrape(record.url, {
          attempt,
          maxAttempts: retryPolicy.options.maxAttempts,
          signal: attemptSignal,
          http: {
            request: (request) => {
              attemptHttpRequests += 1;
              return this.deps.http.request(request);
            },
          },
          proxy: proxyLease,
          session: sessionLease,
          logger: jobLogger,
          now: this.now,
        });
      } catch (error) {
        // Includes failures from acquiring a lease, so a broken pool still
        // produces a row rather than an unhandled rejection.
        result = failureFromThrown(error);
      }

      lastResult = result;
      platformHttpRequests += attemptHttpRequests;
      if (proxyLease !== null) {
        this.reportProxyOutcome(proxyLease, result);
        metrics.recordProxyOutcome(proxyLease.id, proxyOutcomeOf(result));
      }
      if (sessionLease !== null) {
        if (result.acquisition?.sessionUsed === true) {
          this.reportSessionOutcome(sessionLease, result);
        } else {
          this.deps.sessionPool.release(sessionLease);
        }
      }

      if (result.outcome === 'ok') break;
      if (!retryPolicy.isRetryableResult(result)) break;
      if (!retryPolicy.hasAttemptsLeft(attempt)) break;
      if (signal.aborted) break;

      const delayMs = retryPolicy.delayFor(attempt);
      retries += 1;
      metrics.recordRetry();
      jobLogger.debug(
        { attempt, delay_ms: delayMs, error_code: result.error.code },
        'retrying after failure',
      );

      try {
        await this.sleep(delayMs, signal);
      } catch {
        break; // Run cancelled while backing off.
      }
    }

    const latencyMs = Math.max(0, Date.now() - startedAtMs);
    const context = {
      platform: record.platform,
      url: record.url,
      scrapedAt,
      latencyMs,
    };

    const snapshot: MetricSnapshot =
      lastResult !== null && lastResult.outcome === 'ok'
        ? createSuccessSnapshot(context, lastResult.data)
        : createFailureSnapshot(
            context,
            lastResult?.status ?? 'error',
            lastResult?.error ?? {
              code: 'unknown',
              message: 'scraper produced no result',
              retryable: false,
            },
            lastResult?.outcome === 'failure' ? (lastResult.partial ?? {}) : {},
          );

    return { snapshot, attempts: attempt, retries, proxyId: lastProxyId, platformHttpRequests };
  }

  private reportProxyOutcome(lease: ProxyLease, result: ScrapeResult): void {
    const pool = this.deps.proxyPool;
    if (result.outcome === 'ok') {
      pool.reportSuccess(lease);
    } else if (result.status === 'rate_limited' || result.error.code === 'blocked') {
      pool.markBlocked(lease, result.error.message);
    } else if (result.error.retryable) {
      pool.reportFailure(lease, result.error.message);
    } else {
      // A permanent per-URL outcome (not_found/private) says nothing bad about
      // the proxy, so it counts as a healthy use.
      pool.reportSuccess(lease);
    }
    pool.release(lease);
  }

  private reportSessionOutcome(lease: SessionLease, result: ScrapeResult): void {
    const pool = this.deps.sessionPool;
    if (result.outcome === 'ok') {
      pool.reportSuccess(lease);
    } else if (result.error.code === 'blocked' || result.status === 'rate_limited') {
      pool.markBlocked(lease, result.error.message);
    } else if (result.error.retryable) {
      pool.reportFailure(lease, result.error.message);
    } else {
      pool.reportSuccess(lease);
    }
    pool.release(lease);
  }
}

/** A thrown value becomes a failure result so the row is never lost. */
function failureFromThrown(error: unknown): ScrapeResult {
  const scrapeError = ScrapeError.from(error);
  const status: FailureStatus = scrapeError.status === 'ok' ? 'error' : scrapeError.status;
  return { outcome: 'failure', status, error: scrapeError.toInfo() };
}

function proxyOutcomeOf(result: ScrapeResult): 'success' | 'failure' | 'blocked' {
  if (result.outcome === 'ok') return 'success';
  if (result.status === 'rate_limited' || result.error.code === 'blocked') return 'blocked';
  return 'failure';
}

function extractErrorCode(error: string | null): string | null {
  if (error === null) return null;
  const separator = error.indexOf(':');
  return separator === -1 ? error : error.slice(0, separator);
}

function inferPlatform(records: readonly InputRecord[]): Platform | null {
  const first = records[0];
  if (first === undefined) return null;
  return records.every((record) => record.platform === first.platform) ? first.platform : null;
}
