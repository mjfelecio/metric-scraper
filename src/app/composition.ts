import { type AppConfig } from '../config/env.js';
import { ProxyAgent } from 'undici';
import { type Logger } from '../core/logging/logger.js';
import { MetricsCollector } from '../core/metrics/metrics-collector.js';
import { type SnapshotSink } from '../core/output/snapshot-sink.js';
import { RetryPolicy, type RetryPolicyOptions } from '../core/retry/retry-policy.js';
import { type ProxyPool, type SessionPool } from '../core/scraper/pool-ports.js';
import { ScrapeRunner } from '../core/runner/scrape-runner.js';
import { type UrlNormalizerRegistry } from '../core/url/normalizer-registry.js';
import { FetchHttpClient } from '../infrastructure/http/fetch-http-client.js';
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
}): Promise<BuiltRunner> {
  const { config, logger, sink } = options;
  const concurrency = options.overrides?.concurrency ?? config.concurrency;
  const targetRpm = options.overrides?.targetRpm ?? config.targetRpm;

  const proxyPool = options.proxyPool ?? createProxyPool(config, logger);
  const sessionPool = options.sessionPool ?? (await createSessionPool(config, logger));
  const metrics = new MetricsCollector();
  const proxyAgents = new Map<string, ProxyAgent>();

  const http = new FetchHttpClient({
    defaultTimeoutMs: config.requestTimeoutMs,
    dispatcherFactory: (target) => {
      if (target.protocol !== 'http' && target.protocol !== 'https') {
        throw new Error(
          `proxy protocol ${target.protocol} is not supported by the fetch transport; use http or https`,
        );
      }
      let agent = proxyAgents.get(target.url);
      if (agent === undefined) {
        agent = new ProxyAgent(target.url);
        proxyAgents.set(target.url, agent);
      }
      return agent;
    },
  });

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

export function createProxyPool(config: AppConfig, logger: Logger): ProxyPool {
  const targets = parseProxyList(config.proxy.pool);
  if (targets.length === 0) {
    logger.debug('no proxies configured; requests will go out directly');
    return new NullProxyPool();
  }
  logger.info({ proxies: targets.length }, 'proxy pool configured');
  return new InMemoryProxyPool({
    targets,
    maxConsecutiveFailures: config.proxy.maxConsecutiveFailures,
    cooldownMs: config.proxy.cooldownMs,
    logger,
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
