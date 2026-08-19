import { type AppConfig } from '../config/env.js';
import { ProxyAgent } from 'undici';
import { type Logger } from '../core/logging/logger.js';
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
import { FetchHttpClient } from '../infrastructure/http/fetch-http-client.js';
import { RateLimitedHttpClient } from '../infrastructure/http/rate-limited-http-client.js';
import { InMemoryProxyPool, NullProxyPool } from '../infrastructure/proxy/in-memory-proxy-pool.js';
import { parseProxyList } from '../infrastructure/proxy/proxy-config.js';
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

  const transport = new FetchHttpClient({
    defaultTimeoutMs: config.requestTimeoutMs,
    dispatcherFactory: createProxyAgentFactory(config),
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
export function createProxyAgentFactory(config: AppConfig): (target: ProxyTarget) => unknown {
  const proxyAgents = new Map<string, ProxyAgent>();
  return (target) => {
    if (target.protocol !== 'http' && target.protocol !== 'https') {
      throw new Error(
        `proxy protocol ${target.protocol} is not supported by the fetch transport; use http or https`,
      );
    }
    let agent = proxyAgents.get(target.url);
    if (agent === undefined) {
      agent = new ProxyAgent({ uri: target.url, connectTimeout: config.proxy.connectTimeoutMs });
      proxyAgents.set(target.url, agent);
    }
    return agent;
  };
}

export function createProxyPool(
  config: AppConfig,
  logger: Logger,
  onProxyEvent?: ProxyEventListener,
): ProxyPool {
  const targets = parseProxyList(config.proxy.pool);
  if (targets.length === 0) {
    logger.debug('no proxies configured; requests will go out directly');
    return new NullProxyPool();
  }
  logger.info(
    {
      proxies: targets.length,
      max_concurrent_per_proxy: config.proxy.maxConcurrentPerProxy,
      // The ceiling on simultaneous proxied requests. Below the configured
      // concurrency, this — not the queue — is what the run is bounded by.
      capacity:
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
