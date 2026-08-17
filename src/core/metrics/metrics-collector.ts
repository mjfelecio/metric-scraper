import { SCRAPE_STATUSES, type ScrapeStatus } from '../models/status.js';
import { type LeaseOutcome } from '../scraper/lease-ports.js';

import { max as maxOf, mean, percentileOfSorted } from './percentiles.js';

export interface LatencyView {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  meanMs: number | null;
}

export interface ProxyUsageView {
  proxyId: string;
  requests: number;
  successes: number;
  failures: number;
  blocked: boolean;
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
  proxyUsage: ProxyUsageView[];
  proxyFailures: number;
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
  private readonly proxyUsage = new Map<string, ProxyUsageView>();

  constructor(options: { now?: (() => number) | undefined } = {}) {
    this.now = options.now ?? (() => Date.now());
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
  }

  /**
   * One retry attempt. Tracked separately from `recordResult` so that reported
   * throughput counts work items, never retry volume.
   */
  recordRetry(): void {
    this.totalRetries += 1;
  }

  recordProxyOutcome(proxyId: string, outcome: LeaseOutcome): void {
    const usage = this.proxyUsage.get(proxyId) ?? {
      proxyId,
      requests: 0,
      successes: 0,
      failures: 0,
      blocked: false,
    };
    usage.requests += 1;
    switch (outcome) {
      case 'success':
        usage.successes += 1;
        break;
      case 'failure':
        usage.failures += 1;
        break;
      case 'blocked':
        usage.failures += 1;
        usage.blocked = true;
        break;
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
    const proxyUsage = [...this.proxyUsage.values()].map((usage) => ({ ...usage }));

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
      proxyUsage,
      proxyFailures: proxyUsage.reduce((total, usage) => total + usage.failures, 0),
    };
  }
}
