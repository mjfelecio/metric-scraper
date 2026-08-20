import { type Platform } from '../models/platform.js';
import { SCRAPE_STATUSES, type ScrapeStatus } from '../models/status.js';
import { type ProxyOutcome } from '../scraper/lease-ports.js';

import { type BandwidthView } from './bandwidth.js';
import { max as maxOf, mean, percentileOfSorted } from './percentiles.js';

export interface LatencyView {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  meanMs: number | null;
}

/**
 * Per-proxy tallies as the pool itself classified them.
 *
 * `successes` counts healthy uses of the proxy, which includes a `not_found`
 * or `private` answer: the proxy fetched a definitive result, and the pool
 * credits it the same way. `failures` counts what the pool rotated away from.
 * Reading these next to `status_breakdown` is what makes the two reconcilable.
 */
export interface ProxyPlatformUsage {
  requests: number;
  failures: number;
}

export interface ProxyUsageView {
  proxyId: string;
  requests: number;
  successes: number;
  failures: number;
  /** Subset of `failures` blamed on the exit node itself (HTTP 451). */
  unsuitable: number;
  blocked: boolean;
  /**
   * Split by platform, because "the evening run was worse" is often a statement
   * about one platform rather than about the pool. A proxy failing only
   * Instagram while TikTok goes through it fine is not a bad proxy.
   */
  byPlatform: Partial<Record<Platform, ProxyPlatformUsage>>;
  /**
   * Failure reasons as `ScrapeErrorCode`, per proxy.
   *
   * This is what separates a degraded exit node from a code regression:
   * `http_error`/`blocked` concentrated on two proxies is a pool problem, while
   * `parse_error` spread across healthy proxies is ours or the platform's.
   * Neutral outcomes are counted here too — they say nothing about the proxy,
   * but they are exactly the evidence that the proxy is not the culprit.
   */
  byErrorCode: Record<string, number>;
  /** Wire bytes sent through this proxy. `null` when unmeasured. */
  requestBytes: number | null;
  /** Wire bytes received through this proxy. `null` when unmeasured. */
  responseBytes: number | null;
}

/** Everything an attempt says about the proxy beyond the outcome itself. */
export interface ProxyOutcomeContext {
  platform?: Platform | undefined;
  /** `ScrapeErrorCode` for a failure, `null` on success. */
  errorCode?: string | null | undefined;
}

interface ProxyUsageEntry extends Omit<
  ProxyUsageView,
  'byPlatform' | 'byErrorCode' | 'requestBytes' | 'responseBytes'
> {
  byPlatform: Map<Platform, ProxyPlatformUsage>;
  byErrorCode: Map<string, number>;
}

export interface ConcurrencyView {
  /** What the operator asked for. */
  configured: number;
  /** High-water mark of tasks actually running at once. The truth. */
  maxObserved: number;
  /**
   * Mean in-flight over the run: `Σ(latency) / elapsed`.
   *
   * This is the number that catches accidental serialization. A run whose
   * per-URL latencies sum to its wall clock was sequential, and reads ~1.0
   * however high `configured` is.
   */
  effective: number;
  /** `maxObserved / configured`, 0..1. */
  utilization: number;
  /** Whether the ceiling was ever actually reached. */
  saturated: boolean;
}

export interface QueueView {
  /** Deepest the waiting-task backlog ever got. */
  maxDepth: number;
  waitP50Ms: number | null;
  waitP95Ms: number | null;
  waitMaxMs: number | null;
}

/** Where wall-clock time went outside of the request itself. */
export interface WaitView {
  /** Waiting on the job-admission rate limiter, outside any concurrency slot. */
  admissionMs: number;
  /** Waiting on the per-host HTTP rate limiter, inside a concurrency slot. */
  httpRateLimitMs: number;
  /** Waiting to lease a proxy. */
  proxyAcquireMs: number;
  /** Sleeping in retry backoff, holding a concurrency slot. */
  retryBackoffMs: number;
}

export interface MetricsView {
  startedAt: Date | null;
  elapsedMs: number;
  totalRequests: number;
  platformHttpRequests: number;
  successfulRequests: number;
  failedRequests: number;
  /** 0..1; 0 when nothing has completed yet. */
  successRate: number;
  /** Completed requests per minute, excluding retries. */
  throughputPerMinute: number;
  statusCounts: Record<ScrapeStatus, number>;
  errorCounts: Record<string, number>;
  totalRetries: number;
  retriedRequests: number;
  exhaustedRequests: number;
  latency: LatencyView;
  /** Total time spent inside requests. Divided by wall clock, this is mean in-flight. */
  latencySumMs: number;
  proxyUsage: ProxyUsageView[];
  proxyFailures: number;
  concurrency: ConcurrencyView;
  queue: QueueView;
  waits: WaitView;
  /** `null` when measurement is off or nothing was observed. */
  bandwidth: BandwidthView | null;
}

export interface RecordResultInput {
  status: ScrapeStatus;
  latencyMs: number;
  /** Retry attempts used by this request (attempts - 1). */
  retries: number;
  /** Set when the request failed after using every allowed attempt. */
  exhausted: boolean;
  /** `ScrapeErrorCode` for failures, `null` on success. */
  errorCode: string | null;
  /** Raw first-party HTTP calls made across all attempts for this URL. */
  platformHttpRequests?: number | undefined;
}

function emptyStatusCounts(): Record<ScrapeStatus, number> {
  const counts = {} as Record<ScrapeStatus, number>;
  for (const status of SCRAPE_STATUSES) {
    counts[status] = 0;
  }
  return counts;
}

/**
 * In-memory run metrics. Deliberately not tied to any exporter: the CLI, the
 * web dashboard and the run summary all read the same `MetricsView`.
 *
 * Latency samples are kept in full. At the volumes this project targets
 * (hundreds of requests per minute for minutes at a time) that is a few
 * thousand numbers; a histogram/reservoir would be the swap for long runs.
 */
export class MetricsCollector {
  private readonly now: () => number;
  private startedAtMs: number | null = null;
  private finishedAtMs: number | null = null;

  private totalRequests = 0;
  private platformHttpRequests = 0;
  private successfulRequests = 0;
  private failedRequests = 0;
  private totalRetries = 0;
  private retriedRequests = 0;
  private exhaustedRequests = 0;

  private readonly statusCounts = emptyStatusCounts();
  private readonly errorCounts = new Map<string, number>();
  private readonly latencies: number[] = [];
  private latencySum = 0;
  private readonly proxyUsage = new Map<string, ProxyUsageEntry>();

  private configuredConcurrency = 0;
  private peakInFlight = 0;
  private peakQueueDepth = 0;
  private queueWaits: readonly number[] = [];
  private admissionWaitMs = 0;
  private httpRateLimitWaitMs = 0;
  private proxyAcquireMs = 0;
  private retryBackoffMs = 0;
  private bandwidth: BandwidthView | null = null;

  constructor(options: { now?: (() => number) | undefined } = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Records the ceiling the run was configured with, for comparison against reality. */
  configureConcurrency(concurrency: number): void {
    this.configuredConcurrency = concurrency;
  }

  /**
   * Folds in the queue's own measurements. The queue owns the exact in-flight
   * high-water mark; nothing else can observe it reliably.
   */
  recordQueueStats(stats: {
    peakInFlight: number;
    peakQueueDepth: number;
    waitSamples: readonly number[];
  }): void {
    this.peakInFlight = Math.max(this.peakInFlight, stats.peakInFlight);
    this.peakQueueDepth = Math.max(this.peakQueueDepth, stats.peakQueueDepth);
    this.queueWaits = stats.waitSamples;
  }

  recordAdmissionWait(ms: number): void {
    this.admissionWaitMs += Math.max(0, ms);
  }

  recordHttpRateLimitWait(ms: number): void {
    this.httpRateLimitWaitMs += Math.max(0, ms);
  }

  recordProxyAcquire(ms: number): void {
    this.proxyAcquireMs += Math.max(0, ms);
  }

  recordRetryBackoff(ms: number): void {
    this.retryBackoffMs += Math.max(0, ms);
  }

  /** Replaces the last-known bandwidth snapshot with a fresh one from the aggregator. */
  recordBandwidth(view: BandwidthView): void {
    this.bandwidth = view;
  }

  start(): void {
    this.startedAtMs = this.now();
    this.finishedAtMs = null;
  }

  finish(): void {
    this.finishedAtMs = this.now();
  }

  /** One completed request (one URL), after all retries have been exhausted. */
  recordResult(input: RecordResultInput): void {
    this.totalRequests += 1;
    this.platformHttpRequests += input.platformHttpRequests ?? 0;
    if (input.status === 'ok') {
      this.successfulRequests += 1;
    } else {
      this.failedRequests += 1;
    }
    this.statusCounts[input.status] += 1;

    if (input.errorCode !== null) {
      this.errorCounts.set(input.errorCode, (this.errorCounts.get(input.errorCode) ?? 0) + 1);
    }
    if (input.retries > 0) {
      this.retriedRequests += 1;
    }
    if (input.exhausted) {
      this.exhaustedRequests += 1;
    }
    this.latencies.push(input.latencyMs);
    this.latencySum += input.latencyMs;
  }

  /**
   * One retry attempt. Tracked separately from `recordResult` so that reported
   * throughput counts work items, never retry volume.
   */
  recordRetry(): void {
    this.totalRetries += 1;
  }

  /**
   * One lease outcome, using the same classification the pool rotates on.
   *
   * `neutral` outcomes count as a request and nothing else — the pool does not
   * move that proxy's health either, so the two stay in step.
   */
  recordProxyOutcome(
    proxyId: string,
    outcome: ProxyOutcome,
    context: ProxyOutcomeContext = {},
  ): void {
    const usage = this.proxyUsage.get(proxyId) ?? {
      proxyId,
      requests: 0,
      successes: 0,
      failures: 0,
      unsuitable: 0,
      blocked: false,
      byPlatform: new Map<Platform, ProxyPlatformUsage>(),
      byErrorCode: new Map<string, number>(),
    };
    usage.requests += 1;
    switch (outcome) {
      case 'success':
        usage.successes += 1;
        break;
      case 'failure':
        usage.failures += 1;
        break;
      case 'unsuitable':
        usage.failures += 1;
        usage.unsuitable += 1;
        break;
      case 'blocked':
        usage.failures += 1;
        usage.blocked = true;
        break;
      case 'neutral':
        break;
    }

    if (context.platform !== undefined) {
      const platform = usage.byPlatform.get(context.platform) ?? { requests: 0, failures: 0 };
      platform.requests += 1;
      if (outcome !== 'success' && outcome !== 'neutral') platform.failures += 1;
      usage.byPlatform.set(context.platform, platform);
    }
    if (context.errorCode != null) {
      usage.byErrorCode.set(context.errorCode, (usage.byErrorCode.get(context.errorCode) ?? 0) + 1);
    }

    this.proxyUsage.set(proxyId, usage);
  }

  elapsedMs(): number {
    if (this.startedAtMs === null) return 0;
    return Math.max(0, (this.finishedAtMs ?? this.now()) - this.startedAtMs);
  }

  view(): MetricsView {
    const elapsedMs = this.elapsedMs();
    const sorted = [...this.latencies].sort((a, b) => a - b);
    // Keyed by proxy id, so each row can look up its own measured bytes below.
    const bandwidthByProxy = new Map(
      (this.bandwidth?.perProxy ?? [])
        .filter((entry) => entry.proxyId !== null)
        .map((entry) => [entry.proxyId as string, entry]),
    );

    // Copied out rather than shared: a view is a snapshot, and handing out the
    // live maps would let a caller watch (or mutate) the collector's own state.
    const proxyUsage: ProxyUsageView[] = [...this.proxyUsage.values()].map((usage) => {
      const bandwidth = bandwidthByProxy.get(usage.proxyId);
      return {
        ...usage,
        byPlatform: Object.fromEntries(
          [...usage.byPlatform].map(([platform, counts]) => [platform, { ...counts }]),
        ),
        byErrorCode: Object.fromEntries(usage.byErrorCode),
        requestBytes: bandwidth?.requestBytes ?? null,
        responseBytes: bandwidth?.responseBytes ?? null,
      };
    });
    const sortedWaits = [...this.queueWaits].sort((a, b) => a - b);
    const configured = this.configuredConcurrency;

    return {
      startedAt: this.startedAtMs === null ? null : new Date(this.startedAtMs),
      elapsedMs,
      totalRequests: this.totalRequests,
      platformHttpRequests: this.platformHttpRequests,
      successfulRequests: this.successfulRequests,
      failedRequests: this.failedRequests,
      successRate: this.totalRequests === 0 ? 0 : this.successfulRequests / this.totalRequests,
      throughputPerMinute: elapsedMs === 0 ? 0 : (this.totalRequests / elapsedMs) * 60_000,
      statusCounts: { ...this.statusCounts },
      errorCounts: Object.fromEntries(this.errorCounts),
      totalRetries: this.totalRetries,
      retriedRequests: this.retriedRequests,
      exhaustedRequests: this.exhaustedRequests,
      latency: {
        count: sorted.length,
        p50Ms: percentileOfSorted(sorted, 50),
        p95Ms: percentileOfSorted(sorted, 95),
        maxMs: maxOf(sorted),
        meanMs: mean(sorted),
      },
      latencySumMs: this.latencySum,
      proxyUsage,
      proxyFailures: proxyUsage.reduce((total, usage) => total + usage.failures, 0),
      concurrency: {
        configured,
        maxObserved: this.peakInFlight,
        effective: elapsedMs === 0 ? 0 : this.latencySum / elapsedMs,
        utilization: configured === 0 ? 0 : this.peakInFlight / configured,
        saturated: configured > 0 && this.peakInFlight >= configured,
      },
      queue: {
        maxDepth: this.peakQueueDepth,
        waitP50Ms: percentileOfSorted(sortedWaits, 50),
        waitP95Ms: percentileOfSorted(sortedWaits, 95),
        waitMaxMs: maxOf(sortedWaits),
      },
      waits: {
        admissionMs: this.admissionWaitMs,
        httpRateLimitMs: this.httpRateLimitWaitMs,
        proxyAcquireMs: this.proxyAcquireMs,
        retryBackoffMs: this.retryBackoffMs,
      },
      bandwidth: this.bandwidth,
    };
  }
}
