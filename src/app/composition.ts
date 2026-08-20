import { type AppConfig, resolveTargetCapacity } from '../config/env.js';
import { Agent, ProxyAgent, type Dispatcher } from 'undici';
import { type Logger } from '../core/logging/logger.js';
import {
  BandwidthAggregator,
  nullBandwidthSink,
  type BandwidthSink,
} from '../core/metrics/bandwidth.js';
import { MetricsCollector } from '../core/metrics/metrics-collector.js';
import { type SnapshotSink } from '../core/output/snapshot-sink.js';
import { RetryPolicy, type RetryPolicyOptions } from '../core/retry/retry-policy.js';
import { type ProxyTarget } from '../core/scraper/lease-ports.js';
import {
  type ProxyEventListener,
  type ProxyPool,
  type SessionPool,
} from '../core/scraper/pool-ports.js';
import { ScrapeRunner } from '../core/runner/scrape-runner.js';
import { type UrlNormalizerRegistry } from '../core/url/normalizer-registry.js';
import { createCountingInterceptor } from '../infrastructure/http/counting-dispatcher.js';
import { FetchHttpClient } from '../infrastructure/http/fetch-http-client.js';
import { RateLimitedHttpClient } from '../infrastructure/http/rate-limited-http-client.js';
import { InMemoryProxyPool, NullProxyPool } from '../infrastructure/proxy/in-memory-proxy-pool.js';
import { parseProxyList, proxyId } from '../infrastructure/proxy/proxy-config.js';
import { ProxyScrapeSource } from '../infrastructure/proxy/proxyscrape-source.js';
import { ProxySourceManager } from '../infrastructure/proxy/proxy-source-manager.js';
import { HttpCanaryProxyProbe } from '../infrastructure/proxy/http-canary-proxy-probe.js';
import {
  InMemorySessionPool,
  NullSessionPool,
} from '../infrastructure/session/in-memory-session-pool.js';
import { loadSessionsFromFile } from '../infrastructure/session/session-store.js';
import {
  createDefaultScraperRegistry,
  createDefaultUrlNormalizerRegistry,
} from '../platforms/index.js';

export interface RunnerOverrides {
  concurrency?: number | undefined;
  targetRpm?: number | undefined;
  burst?: number | undefined;
  httpRpmPerHost?: number | undefined;
  retry?: Partial<RetryPolicyOptions> | undefined;
}

export interface BuiltRunner {
  runner: ScrapeRunner;
  metrics: MetricsCollector;
  proxyPool: ProxyPool;
  sessionPool: SessionPool;
  normalizers: UrlNormalizerRegistry;
  concurrency: number;
  targetRpm: number;
  /** `null` when `METRICS_BANDWIDTH` is off; otherwise holds the run's wire-byte totals. */
  bandwidth: BandwidthAggregator | null;
}

/**
 * Composition root: the single place where configuration becomes objects.
 *
 * Everything below this line takes its collaborators as constructor arguments,
 * which is what makes the runner testable and what will let real platform
 * implementations slot in without touching orchestration.
 */
export async function buildRunner(options: {
  config: AppConfig;
  logger: Logger;
  sink: SnapshotSink;
  overrides?: RunnerOverrides | undefined;
  /**
   * Reuse pools across calls instead of building fresh ones.
   *
   * A continuous session builds a runner per cycle but must keep one set of
   * pools for its whole life: proxy and session cooldowns are measured in
   * minutes, so rebuilding them every cycle would silently un-bench every
   * proxy that had just been benched for failing.
   */
  proxyPool?: ProxyPool | undefined;
  sessionPool?: SessionPool | undefined;
  /**
   * Notified on every proxy health transition. Ignored when `proxyPool` is
   * supplied — a caller that brought its own pool already chose its listener.
   */
  onProxyEvent?: ProxyEventListener | undefined;
}): Promise<BuiltRunner> {
  const { config, logger, sink } = options;
  const concurrency = options.overrides?.concurrency ?? config.concurrency;
  const targetRpm = options.overrides?.targetRpm ?? config.targetRpm;
  const burst = options.overrides?.burst ?? config.burst;
  const httpRpmPerHost = options.overrides?.httpRpmPerHost ?? config.httpRpmPerHost;

  const proxyPool = options.proxyPool ?? createProxyPool(config, logger, options.onProxyEvent);
  const sessionPool = options.sessionPool ?? (await createSessionPool(config, logger));
  const metrics = new MetricsCollector();

  // `dispatcherFactory` is consulted only when a request has a proxy assigned,
  // so the direct path needs its own composed dispatcher passed explicitly —
  // otherwise every proxy-less run reports zero bandwidth. Passed explicitly
  // rather than via `setGlobalDispatcher`, which would silently capture
  // traffic elsewhere in the process.
  const bandwidth = config.metricsBandwidth ? new BandwidthAggregator() : null;
  const bandwidthSink: BandwidthSink = bandwidth ?? nullBandwidthSink;

  const transport = new FetchHttpClient({
    defaultTimeoutMs: config.requestTimeoutMs,
    dispatcherFactory: createProxyAgentFactory(config, bandwidthSink),
    ...(bandwidth === null
      ? {}
      : {
          defaultDispatcher: new Agent().compose(
            // The interceptor is typed loosely (`unknown`) so this file does not
            // have to depend on undici's exact dispatch/handler types.
            createCountingInterceptor({ sink: bandwidthSink, proxyId: null }) as never,
          ),
        }),
  });

  // Egress limiting wraps the transport, so retries and the multi-hop calls a
  // platform scraper makes internally are all counted. A job-level limit cannot
  // see that traffic.
  const http =
    httpRpmPerHost > 0
      ? new RateLimitedHttpClient({
          inner: transport,
          rpmPerHost: httpRpmPerHost,
          ...(burst > 0 ? { burst } : {}),
          onWait: (waitMs) => metrics.recordHttpRateLimitWait(waitMs),
        })
      : transport;

  const runner = new ScrapeRunner({
    scrapers: createDefaultScraperRegistry({ instagram: config.instagram }),
    http,
    proxyPool,
    sessionPool,
    sink,
    metrics,
    bandwidth,
    retryPolicy: new RetryPolicy({ ...config.retry, ...options.overrides?.retry }),
    logger,
    config: {
      concurrency,
      targetRpm,
      ...(burst > 0 ? { burst } : {}),
      maxQueueSize: config.maxQueueSize,
      requestTimeoutMs: config.requestTimeoutMs,
    },
  });

  return {
    runner,
    metrics,
    proxyPool,
    sessionPool,
    normalizers: createDefaultUrlNormalizerRegistry(),
    concurrency,
    targetRpm,
    bandwidth,
  };
}

/**
 * Builds a per-proxy `ProxyAgent` dispatcher, one per distinct proxy URL, with
 * an explicit connect-phase timeout.
 *
 * Undici defaults to a 10s connect timeout otherwise, which lets a dead proxy
 * sit half-connected for 10s per attempt — most of a 15s request timeout that
 * never gets the chance to fire, and the dominant cost of scraping through a
 * partly-dead pool.
 */
export function createProxyAgentFactory(
  config: AppConfig,
  sink: BandwidthSink,
): (target: ProxyTarget) => unknown {
  const proxyAgents = new Map<string, ProxyAgent | Dispatcher>();
  return (target) => {
    if (target.protocol !== 'http' && target.protocol !== 'https') {
      throw new Error(
        `proxy protocol ${target.protocol} is not supported by the fetch transport; use http or https`,
      );
    }
    let agent = proxyAgents.get(target.url);
    if (agent === undefined) {
      const base = new ProxyAgent({
        uri: target.url,
        connectTimeout: config.proxy.connectTimeoutMs,
      });
      // Composed per target so the proxy id is captured for attribution.
      agent = config.metricsBandwidth
        ? base.compose(createCountingInterceptor({ sink, proxyId: proxyId(target) }) as never)
        : base;
      proxyAgents.set(target.url, agent);
    }
    return agent;
  };
}

/**
 * A pool plus, when configured, the service that keeps it stocked.
 *
 * Returned together because their lifetimes are the same: the manager holds
 * timers and must be stopped wherever the pool stops being used.
 */
export interface ProxySupply {
  pool: ProxyPool;
  /** `null` unless `PROXY_SOURCE_URL` is set. */
  source: ProxySourceManager | null;
}

/**
 * Builds the proxy pool and, if a candidate source is configured, wires it in.
 *
 * The static `PROXY_POOL` list keeps working exactly as before: its entries are
 * seeded first and marked `config`, which is what exempts them from the
 * eviction the dynamic source applies to its own candidates.
 */
export function createProxySupply(
  config: AppConfig,
  logger: Logger,
  onProxyEvent?: ProxyEventListener,
  /**
   * The concurrency the run will actually use, overrides included.
   *
   * Passed in rather than read off the config because the supply target is
   * derived from it: a run started at `--concurrency 100` needs a pool sized
   * for 100, not for whatever the file said.
   */
  concurrency: number = config.concurrency,
): ProxySupply {
  const sourceUrl = config.proxy.source.url;
  const pool = createProxyPool(config, logger, onProxyEvent, sourceUrl !== '');
  if (sourceUrl === '' || !(pool instanceof InMemoryProxyPool)) {
    return { pool, source: null };
  }

  // Direct transport, deliberately: fetching the list of proxies through a
  // proxy we are not yet sure works would make an empty pool unrecoverable.
  const http = new FetchHttpClient({ defaultTimeoutMs: config.requestTimeoutMs });
  const settings = config.proxy.source;
  const targetCapacity = resolveTargetCapacity(config, concurrency);

  const source = new ProxySourceManager({
    source: new ProxyScrapeSource({ url: sourceUrl, http, logger }),
    // The probe gets production's own connect budget on purpose: certifying a
    // proxy under a budget the real request will not grant it is how a probe
    // ends up admitting candidates that fail on their very first job.
    probe: new HttpCanaryProxyProbe({
      timeoutMs: settings.validateTimeoutMs,
      connectTimeoutMs: config.proxy.connectTimeoutMs,
    }),
    roster: pool,
    targetCapacity,
    minCapacity: settings.minCapacity,
    validateConcurrency: settings.validateConcurrency,
    refreshIntervalMs: settings.refreshIntervalMs,
    maxCandidates: settings.maxCandidates,
    logger,
  });

  if (config.proxy.maxConcurrentPerProxy === 0) {
    logger.warn(
      'PROXY_MAX_CONCURRENT is 0, so per-proxy capacity is unbounded and the supply target ' +
        'falls back to counting usable proxies; set a limit for the target to mean slots',
    );
  }

  logger.info(
    {
      target_capacity: targetCapacity,
      min_capacity: settings.minCapacity,
      concurrency,
      configured: pool.size,
    },
    'dynamic proxy source configured',
  );
  return { pool, source };
}

export function createProxyPool(
  config: AppConfig,
  logger: Logger,
  onProxyEvent?: ProxyEventListener,
  /** Keep a real pool even with no static entries, so a source can fill it. */
  allowEmpty = false,
): ProxyPool {
  const targets = parseProxyList(config.proxy.pool);
  if (targets.length === 0 && !allowEmpty) {
    logger.debug('no proxies configured; requests will go out directly');
    return new NullProxyPool();
  }
  if (targets.length > 0)
    logger.info(
      {
        proxies: targets.length,
        max_concurrent_per_proxy: config.proxy.maxConcurrentPerProxy,
        // The ceiling on simultaneous proxied requests, reached only once every
        // proxy has earned its full concurrency. Below the configured
        // concurrency, this — not the queue — is what the run is bounded by.
        max_capacity:
          config.proxy.maxConcurrentPerProxy === 0
            ? null
            : targets.length * config.proxy.maxConcurrentPerProxy,
      },
      'proxy pool configured',
    );
  return new InMemoryProxyPool({
    targets,
    maxConsecutiveFailures: config.proxy.maxConsecutiveFailures,
    cooldownMs: config.proxy.cooldownMs,
    maxConcurrentPerProxy: config.proxy.maxConcurrentPerProxy,
    probationConcurrency: config.proxy.probationConcurrency,
    explorationPeriod: config.proxy.explorationPeriod,
    acquireWaitMs: config.proxy.acquireWaitMs,
    // A source-fed pool can be evicted down to nothing and refilled seconds
    // later. Reading that empty moment as "no proxies wanted" would send the
    // request out on the origin IP.
    requireProxy: allowEmpty,
    logger,
    ...(onProxyEvent === undefined ? {} : { onEvent: onProxyEvent }),
  });
}

export async function createSessionPool(config: AppConfig, logger: Logger): Promise<SessionPool> {
  if (config.session.storePath === null) {
    logger.debug('no session store configured; running anonymously');
    return new NullSessionPool();
  }
  const sessions = await loadSessionsFromFile(config.session.storePath);
  logger.info({ sessions: sessions.length }, 'session pool configured');
  return new InMemorySessionPool({
    sessions,
    maxConsecutiveFailures: config.session.maxConsecutiveFailures,
    cooldownMs: config.session.cooldownMs,
    logger,
  });
}
