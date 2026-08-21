import { type Logger } from '../core/logging/logger.js';
import { type MetricsCollector } from '../core/metrics/metrics-collector.js';
import { ScrapeError, type ScrapeErrorInfo } from '../core/models/errors.js';
import {
  type InputIssue,
  type InputRecord,
  type PreparedInput,
  type PreparedInputItem,
} from '../core/models/input.js';
import { type FailureStatus } from '../core/models/status.js';
import { type RetryPolicy } from '../core/retry/retry-policy.js';
import { realSleep, type Sleep } from '../core/retry/sleep.js';
import { classifyProxyOutcome } from '../core/runner/proxy-outcome.js';
import { type HttpClient } from '../core/scraper/http-port.js';
import { type ProxyLease, type ProxyOutcome } from '../core/scraper/lease-ports.js';
import { type ProxyProvider } from '../core/scraper/provider-ports.js';
import { type UrlResolutionResult, type UrlResolverRegistry } from '../core/url/resolver.js';

export interface InputPreparerOptions {
  resolvers: UrlResolverRegistry;
  http: HttpClient;
  proxyProvider: ProxyProvider;
  retryPolicy: RetryPolicy;
  logger: Logger;
  metrics?: MetricsCollector | undefined;
  concurrency: number;
  requestTimeoutMs: number;
  cache?: Map<string, ResolvedUrl> | undefined;
  sleep?: Sleep | undefined;
  now?: (() => number) | undefined;
}

export interface PrepareInputOptions {
  signal?: AbortSignal | undefined;
}

export interface ResolvedUrl {
  url: string;
  videoId: string;
}

interface ResolutionAttemptResult {
  result: UrlResolutionResult;
  proxyId: string | null;
  httpRequests: number;
}

/** Resolves network-dependent URLs, then performs stable canonical de-duplication. */
export class InputPreparer {
  private readonly sleep: Sleep;
  private readonly now: () => number;
  private readonly cache: Map<string, ResolvedUrl>;

  constructor(private readonly options: InputPreparerOptions) {
    this.sleep = options.sleep ?? realSleep;
    this.now = options.now ?? Date.now;
    this.cache = options.cache ?? new Map<string, ResolvedUrl>();
  }

  async prepare(
    records: readonly InputRecord[],
    options: PrepareInputOptions = {},
  ): Promise<PreparedInput> {
    const controller = new AbortController();
    const signal =
      options.signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, options.signal]);
    const resolved = new Array<PreparedInputItem>(records.length);
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      while (!signal.aborted) {
        const index = nextIndex;
        nextIndex += 1;
        const record = records[index];
        if (record === undefined) return;
        resolved[index] = await this.prepareOne(record, signal);
      }
    };

    const workerCount = Math.min(Math.max(1, this.options.concurrency), records.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
    if (signal.aborted) {
      throw new ScrapeError({ code: 'cancelled', message: 'URL preparation was cancelled' });
    }

    const items: PreparedInputItem[] = [];
    const issues: InputIssue[] = [];
    const seen = new Map<string, number>();

    for (const item of resolved) {
      if (item.kind === 'failure') {
        items.push(item);
        continue;
      }
      const firstSeenAt = seen.get(item.record.url);
      if (firstSeenAt !== undefined) {
        issues.push({
          code: 'duplicate_url',
          message: `duplicate of the entry at position ${firstSeenAt} after URL resolution`,
          position: item.record.position,
          value: item.record.raw_url,
        });
        continue;
      }
      seen.set(item.record.url, item.record.position);
      items.push(item);
    }

    return { items, issues };
  }

  private async prepareOne(record: InputRecord, signal: AbortSignal): Promise<PreparedInputItem> {
    if (record.requires_resolution !== true) {
      return { kind: 'ready', record, resolution: null };
    }

    const cached = this.cache.get(record.url);
    if (cached !== undefined) {
      return { kind: 'ready', record: canonicalRecord(record, cached), resolution: null };
    }

    const resolver = this.options.resolvers.get(record.platform);
    if (resolver === undefined) {
      return resolutionFailure(record, 'error', {
        code: 'not_implemented',
        message: `no URL resolver is registered for ${record.platform}`,
        retryable: false,
      });
    }

    const startedAt = this.now();
    let attempts = 0;
    let retries = 0;
    let totalHttpRequests = 0;
    let lastProxyId: string | null = null;
    let lastResult: UrlResolutionResult | null = null;

    while (attempts < this.options.retryPolicy.options.maxAttempts && !signal.aborted) {
      attempts += 1;
      const attempt = await this.resolveAttempt(record, resolver, signal);
      lastResult = attempt.result;
      lastProxyId = attempt.proxyId;
      totalHttpRequests += attempt.httpRequests;

      if (attempt.result.outcome === 'ok') {
        const value = { url: attempt.result.url, videoId: attempt.result.videoId };
        this.cache.set(record.url, value);
        return {
          kind: 'ready',
          record: canonicalRecord(record, value),
          resolution: {
            attempts,
            retries,
            proxyId: lastProxyId,
            platformHttpRequests: totalHttpRequests,
            latencyMs: Math.max(0, this.now() - startedAt),
          },
        };
      }

      if (!attempt.result.error.retryable || !this.options.retryPolicy.hasAttemptsLeft(attempts)) {
        break;
      }
      retries += 1;
      this.options.metrics?.recordRetry();
      const backoffStartedAt = this.now();
      await this.sleep(this.options.retryPolicy.delayFor(attempts), signal);
      this.options.metrics?.recordRetryBackoff(this.now() - backoffStartedAt);
    }

    const fallback = lastResult?.outcome === 'failure' ? lastResult : cancelledResolution();
    return {
      kind: 'failure',
      record,
      status: fallback.status,
      error: fallback.error,
      resolution: {
        attempts,
        retries,
        proxyId: lastProxyId,
        platformHttpRequests: totalHttpRequests,
        latencyMs: Math.max(0, this.now() - startedAt),
      },
    };
  }

  private async resolveAttempt(
    record: InputRecord,
    resolver: NonNullable<ReturnType<UrlResolverRegistry['get']>>,
    signal: AbortSignal,
  ): Promise<ResolutionAttemptResult> {
    let lease: ProxyLease | null = null;
    let httpRequests = 0;
    let result: UrlResolutionResult;

    try {
      const acquireStartedAt = this.now();
      lease = await this.options.proxyProvider.acquire({
        platform: record.platform,
        attempt: 1,
        signal,
      });
      this.options.metrics?.recordProxyAcquire(this.now() - acquireStartedAt);
      const attemptSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(this.options.requestTimeoutMs),
      ]);
      result = await resolver.resolve(record.url, {
        http: {
          request: (request) => {
            httpRequests += 1;
            return this.options.http.request(request);
          },
        },
        proxy: lease?.target ?? null,
        signal: attemptSignal,
        logger: this.options.logger.child({ url: record.url, platform: record.platform }),
      });
    } catch (error) {
      const scrapeError = ScrapeError.from(error);
      result = {
        outcome: 'failure',
        status: scrapeError.status === 'ok' ? 'error' : scrapeError.status,
        error: scrapeError.toInfo(),
      };
    }

    if (lease !== null) this.reportProxyOutcome(lease, result, record.platform);
    return { result, proxyId: lease?.id ?? null, httpRequests };
  }

  private reportProxyOutcome(
    lease: ProxyLease,
    result: UrlResolutionResult,
    platform: InputRecord['platform'],
  ): void {
    const outcome: ProxyOutcome =
      result.outcome === 'ok'
        ? 'success'
        : classifyProxyOutcome({
            outcome: 'failure',
            status: result.status,
            error: result.error,
          });
    const reason = result.outcome === 'failure' ? result.error.message : undefined;
    const code = result.outcome === 'failure' ? result.error.code : undefined;

    this.options.metrics?.recordProxyOutcome(lease.id, outcome, {
      platform,
      errorCode: code ?? null,
    });

    // The provider owns what an outcome means for proxy health: the static
    // pool benches on it, a rotating gateway deliberately does not.
    this.options.proxyProvider.release(lease, outcome, { reason, errorCode: code });
  }
}

function canonicalRecord(record: InputRecord, resolved: ResolvedUrl): InputRecord {
  return { ...record, url: resolved.url, requires_resolution: false };
}

function resolutionFailure(
  record: InputRecord,
  status: FailureStatus,
  error: ScrapeErrorInfo,
): PreparedInputItem {
  return {
    kind: 'failure',
    record,
    status,
    error,
    resolution: {
      attempts: 0,
      retries: 0,
      proxyId: null,
      platformHttpRequests: 0,
      latencyMs: 0,
    },
  };
}

function cancelledResolution(): Extract<UrlResolutionResult, { outcome: 'failure' }> {
  return {
    outcome: 'failure',
    status: 'error',
    error: { code: 'cancelled', message: 'URL resolution was cancelled', retryable: false },
  };
}
