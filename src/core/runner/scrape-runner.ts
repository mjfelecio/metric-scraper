import { randomUUID } from 'node:crypto';

import {
  PQueueTaskQueue,
  type TaskQueue,
  type TaskQueueOptions,
} from '../concurrency/task-queue.js';
import { type Logger } from '../logging/logger.js';
import { type BandwidthAggregator } from '../metrics/bandwidth.js';
import { type MetricsCollector } from '../metrics/metrics-collector.js';
import { createRateLimiter, type RateLimiter } from '../rate-limit/rate-limit.js';
import { ScrapeError, type ScrapeErrorInfo } from '../models/errors.js';
import { type InputRecord, type PreparedInputItem } from '../models/input.js';
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
import { type SessionPool } from '../scraper/pool-ports.js';
import { type ProxyProvider } from '../scraper/provider-ports.js';
import { type ScraperRegistry } from '../scraper/scraper.js';

import { buildRunSummary } from './build-summary.js';
import { classifyProxyOutcome } from './proxy-outcome.js';
import { type JobCompletedEvent, type RunCounts, type RunProgress } from './types.js';

export interface ScrapeRunnerConfig {
  /** Ceiling on jobs in flight at once. */
  concurrency: number;
  /** Logical scrape jobs admitted per minute. One URL = one unit, retries included. */
  targetRpm: number;
  /** Jobs admissible at once after an idle period. Defaults to one second's worth. */
  burst?: number | undefined;
  /** Waiting (not running) jobs before the producer is made to wait. `0` = unbounded. */
  maxQueueSize: number;
  /** Maximum duration of one complete attempt, selected by the record's platform. */
  attemptTimeoutMsByPlatform: Readonly<Record<Platform, number>>;
}

export interface ScrapeRunnerDeps {
  scrapers: ScraperRegistry;
  http: HttpClient;
  proxyProvider: ProxyProvider;
  sessionPool: SessionPool;
  sink: SnapshotSink;
  metrics: MetricsCollector;
  /**
   * `null`/omitted when `METRICS_BANDWIDTH` is off. When present, its live
   * totals are folded into `metrics` right before the run summary is built,
   * so the summary reflects the run's final byte counts rather than staying
   * permanently unset.
   */
  bandwidth?: BandwidthAggregator | null | undefined;
  retryPolicy: RetryPolicy;
  logger: Logger;
  config: ScrapeRunnerConfig;
  /** Overridable for tests. */
  createQueue?: ((options: TaskQueueOptions) => TaskQueue) | undefined;
  /** Job-admission rate limiter. Built from `config.targetRpm` when omitted. */
  rateLimiter?: RateLimiter | undefined;
  sleep?: Sleep | undefined;
  now?: (() => Date) | undefined;
  /** Creates the per-attempt deadline signal. Overridable for deterministic tests. */
  createTimeoutSignal?: ((delayMs: number) => AbortSignal) | undefined;
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
  private readonly createTimeoutSignal: (delayMs: number) => AbortSignal;

  constructor(deps: ScrapeRunnerDeps) {
    this.deps = deps;
    this.sleep = deps.sleep ?? realSleep;
    this.now = deps.now ?? (() => new Date());
    this.createTimeoutSignal =
      deps.createTimeoutSignal ?? ((delayMs) => AbortSignal.timeout(delayMs));
  }

  async run(
    records: readonly (InputRecord | PreparedInputItem)[],
    options: RunOptions = {},
  ): Promise<RunResult> {
    const { config, logger, metrics, sink } = this.deps;
    const runId = options.runId ?? randomUUID();
    const runLogger = logger.child({ run_id: runId });
    const runCache = new Map<string, unknown>();

    const controller = new AbortController();
    const signal =
      options.signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, options.signal]);

    const queueOptions: TaskQueueOptions = {
      concurrency: config.concurrency,
      maxQueueSize: config.maxQueueSize,
    };
    const queue = this.deps.createQueue?.(queueOptions) ?? new PQueueTaskQueue(queueOptions);

    // Rate is a separate policy from concurrency. It paces admission *outside*
    // the queue, so a job waiting for a token never occupies a concurrency slot.
    const rateLimiter =
      this.deps.rateLimiter ??
      createRateLimiter({
        rpm: config.targetRpm,
        ...(config.burst === undefined ? {} : { burst: config.burst }),
      });

    const startedAt = this.now();
    metrics.start();
    metrics.configureConcurrency(config.concurrency);
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

    const submit = (record: InputRecord | PreparedInputItem): void => {
      void queue
        .add(async () => {
          if (signal.aborted) return;
          const event = await this.processPreparedItem(record, signal, runLogger, runCache);

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
          if (fatalError === null) {
            fatalError = ScrapeError.from(error);
            queue.clear();
            controller.abort(fatalError);
          }
        });
    };

    // Producer loop. Both gates are awaited *before* the job enters the queue:
    // backpressure bounds how much work may be pending, and the rate limiter
    // paces how fast work starts. Neither consumes a concurrency slot, and the
    // submitted task is deliberately not awaited here — awaiting it would
    // serialize the run no matter how the queue is configured.
    for (const record of records) {
      if (signal.aborted) break;

      await queue.awaitCapacity(signal);
      if (signal.aborted) break;

      const admissionStart = Date.now();
      try {
        await rateLimiter.acquire(signal);
      } catch {
        break; // Run cancelled while waiting for a token.
      }
      metrics.recordAdmissionWait(Date.now() - admissionStart);
      if (signal.aborted) break;

      submit(record);
    }

    await queue.onIdle();

    metrics.recordQueueStats(queue.stats());
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

    // Refreshed here, right before the summary is assembled, so the summary
    // reflects the run's final totals rather than whatever was last sampled.
    if (this.deps.bandwidth != null) {
      metrics.recordBandwidth(this.deps.bandwidth.view());
    }

    const summary = buildRunSummary({
      runId,
      platform: options.platform ?? inferPlatform(records),
      startedAt,
      finishedAt,
      counts,
      metrics: metrics.view(),
      proxyStats: this.deps.proxyProvider.getStats(),
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

  private async processPreparedItem(
    item: InputRecord | PreparedInputItem,
    signal: AbortSignal,
    logger: Logger,
    runCache: Map<string, unknown>,
  ): Promise<JobCompletedEvent> {
    if (!('kind' in item)) return this.processRecord(item, signal, logger, runCache);

    if (item.kind === 'failure') {
      return {
        snapshot: createFailureSnapshot(
          {
            platform: item.record.platform,
            url: item.record.url,
            scrapedAt: this.now(),
            latencyMs: item.resolution.latencyMs,
          },
          item.status,
          item.error,
        ),
        attempts: item.resolution.attempts,
        retries: item.resolution.retries,
        proxyId: item.resolution.proxyId,
        platformHttpRequests: item.resolution.platformHttpRequests,
      };
    }

    const event = await this.processRecord(item.record, signal, logger, runCache);
    if (item.resolution === null) return event;
    return {
      ...event,
      snapshot: {
        ...event.snapshot,
        latency_ms: event.snapshot.latency_ms + item.resolution.latencyMs,
      },
      attempts: event.attempts + item.resolution.attempts,
      retries: event.retries + item.resolution.retries,
      proxyId: event.proxyId ?? item.resolution.proxyId,
      platformHttpRequests: event.platformHttpRequests + item.resolution.platformHttpRequests,
    };
  }

  /**
   * Runs one URL through the attempt chain. Always resolves with a row —
   * a failure is data, not an exception.
   */
  private async processRecord(
    record: InputRecord,
    signal: AbortSignal,
    logger: Logger,
    runCache: Map<string, unknown>,
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
        // Timed so that a provider which starts blocking (per-proxy capacity,
        // or a fully cooling-down pool) can never become an invisible serializer.
        const acquireStart = Date.now();
        proxyLease = await this.deps.proxyProvider.acquire({
          platform: record.platform,
          attempt,
          signal,
        });
        sessionLease = await this.deps.sessionPool.acquire(
          record.platform,
          signal,
          proxyLease?.id ?? null,
        );
        metrics.recordProxyAcquire(Date.now() - acquireStart);
        lastProxyId = proxyLease?.id ?? null;

        // One request and one attempt are different budgets. The HTTP client
        // applies a fresh request timeout to every outbound call; this signal
        // bounds the whole platform workflow and preserves run cancellation.
        const attemptTimeoutMs = config.attemptTimeoutMsByPlatform[record.platform];
        const attemptSignal = AbortSignal.any([signal, this.createTimeoutSignal(attemptTimeoutMs)]);

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
          runCache,
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
        // Classified once, then reported to both the provider and the metrics,
        // so rotation state and the summary can never disagree about what this
        // attempt said about the proxy.
        const proxyOutcome = classifyProxyOutcome(result);
        this.deps.proxyProvider.release(proxyLease, proxyOutcome, {
          reason: result.outcome === 'ok' ? undefined : result.error.message,
          // Carried alongside the message so a provider can say *what kind* of
          // failure this was, not just that something failed.
          errorCode: result.outcome === 'ok' ? undefined : result.error.code,
        });
        metrics.recordProxyOutcome(proxyLease.id, proxyOutcome, {
          platform: record.platform,
          errorCode: result.outcome === 'ok' ? null : result.error.code,
        });
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

      // Backoff holds a concurrency slot for its whole duration, so it is
      // recorded: an idle-looking slot must always be attributable.
      const backoffStart = Date.now();
      try {
        await this.sleep(delayMs, signal);
      } catch {
        break; // Run cancelled while backing off.
      } finally {
        metrics.recordRetryBackoff(Date.now() - backoffStart);
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

function extractErrorCode(error: string | null): string | null {
  if (error === null) return null;
  const separator = error.indexOf(':');
  return separator === -1 ? error : error.slice(0, separator);
}

function inferPlatform(records: readonly (InputRecord | PreparedInputItem)[]): Platform | null {
  const normalized = records.map((item) => ('kind' in item ? item.record : item));
  const first = normalized[0];
  if (first === undefined) return null;
  return normalized.every((record) => record.platform === first.platform) ? first.platform : null;
}
