import { type AppConfig, resolveTargetCapacity } from '../config/env.js';
import { Agent, ProxyAgent, type Dispatcher } from 'undici';
import { nullLogger, type Logger } from '../core/logging/logger.js';
import {
  BandwidthAggregator,
  nullBandwidthSink,
  type BandwidthSample,
  type BandwidthSink,
} from '../core/metrics/bandwidth.js';
import { MetricsCollector } from '../core/metrics/metrics-collector.js';
import { ScrapeError } from '../core/models/errors.js';
import { type SnapshotSink } from '../core/output/snapshot-sink.js';
import { RetryPolicy, type RetryPolicyOptions } from '../core/retry/retry-policy.js';
import { type ProxyTarget } from '../core/scraper/lease-ports.js';
import {
  type ProxyEventListener,
  type ProxyPool,
  type SessionPool,
} from '../core/scraper/pool-ports.js';
import { type ProxyProvider } from '../core/scraper/provider-ports.js';
import { type HttpClient } from '../core/scraper/http-port.js';
import { ScrapeRunner } from '../core/runner/scrape-runner.js';
import { type UrlNormalizerRegistry } from '../core/url/normalizer-registry.js';
import { createCountingInterceptor } from '../infrastructure/http/counting-dispatcher.js';
import { FetchHttpClient } from '../infrastructure/http/fetch-http-client.js';
import { RateLimitedHttpClient } from '../infrastructure/http/rate-limited-http-client.js';
import { InMemoryProxyPool, NullProxyPool } from '../infrastructure/proxy/in-memory-proxy-pool.js';
import { buildProxyTarget, parseProxyList, proxyId } from '../infrastructure/proxy/proxy-config.js';
import { RotatingResidentialProxyProvider } from '../infrastructure/proxy/rotating-residential-proxy-provider.js';
import { StaticProxyProvider } from '../infrastructure/proxy/static-proxy-provider.js';
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
  createDefaultUrlResolverRegistry,
} from '../platforms/index.js';
import { InputPreparer, type ResolvedUrl } from './input-preparer.js';

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
  proxyProvider: ProxyProvider;
  sessionPool: SessionPool;
  normalizers: UrlNormalizerRegistry;
  /** Optional only for lightweight test-built runners; production always supplies it. */
  inputPreparer?: InputPreparer | undefined;
  concurrency: number;
  targetRpm: number;
  /** `null` when `METRICS_BANDWIDTH` is off; otherwise holds the run's wire-byte totals. */
  bandwidth: BandwidthAggregator | null;
  /** Releases transport resources owned by this build. Safe to call repeatedly. */
  dispose(): Promise<void>;
}

/** Session-safe HTTP transport whose connection pools outlive individual runners. */
export interface ManagedHttpTransport {
  clientFor(sink: BandwidthSink): HttpClient;
  close(): Promise<void>;
}

class SwitchableBandwidthSink implements BandwidthSink {
  private current: BandwidthSink = nullBandwidthSink;

  use(sink: BandwidthSink): void {
    this.current = sink;
  }

  record(sample: BandwidthSample): void {
    this.current.record(sample);
  }
}

/**
 * Owns direct and per-proxy Undici agents. `clientFor` may be called once per
 * sequential cycle; dispatchers stay stable while byte accounting moves to
 * that cycle's aggregator.
 */
export function createManagedHttpTransport(
  config: AppConfig,
  logger: Logger = nullLogger,
): ManagedHttpTransport {
  const bandwidth = new SwitchableBandwidthSink();
  const directBase = new Agent();
  const directDispatcher = config.metricsBandwidth
    ? directBase.compose(createCountingInterceptor({ sink: bandwidth, proxyId: null }))
    : directBase;
  const proxyAgents = new Map<
    string,
    { id: string; base: ProxyAgent; dispatcher: ProxyAgent | Dispatcher }
  >();
  let closePromise: Promise<void> | null = null;

  return {
    clientFor(sink) {
      if (closePromise !== null) {
        throw new ScrapeError({
          code: 'config_error',
          message: 'HTTP transport is already closed',
        });
      }
      bandwidth.use(sink);
      return new FetchHttpClient({
        defaultTimeoutMs: config.requestTimeoutMs,
        defaultDispatcher: directDispatcher,
        dispatcherFactory: (target) => {
          if (target.protocol !== 'http' && target.protocol !== 'https') {
            throw new Error(
              `proxy protocol ${target.protocol} is not supported by the fetch transport; use http or https`,
            );
          }
          let entry = proxyAgents.get(target.url);
          if (entry === undefined) {
            const base = new ProxyAgent({
              uri: target.url,
              connectTimeout: config.proxy.connectTimeoutMs,
            });
            entry = {
              id: proxyId(target),
              base,
              dispatcher: config.metricsBandwidth
                ? base.compose(
                    createCountingInterceptor({ sink: bandwidth, proxyId: proxyId(target) }),
                  )
                : base,
            };
            proxyAgents.set(target.url, entry);
          }
          return entry.dispatcher;
        },
      });
    },
    close() {
      closePromise ??= Promise.allSettled([
        directBase.close(),
        ...[...proxyAgents.values()].map((entry) => entry.base.close()),
      ]).then((results) => {
        const identities: (string | null)[] = [
          null,
          ...[...proxyAgents.values()].map((entry) => entry.id),
        ];
        for (const [index, result] of results.entries()) {
          if (result.status !== 'rejected') continue;
          logger.warn(
            {
              proxy_id: identities[index] ?? null,
              message:
                result.reason instanceof Error ? result.reason.message : String(result.reason),
            },
            'could not close HTTP dispatcher',
          );
        }
      });
      return closePromise;
    },
  };
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
   * Reuse the provider and session pool across calls instead of building fresh
   * ones.
   *
   * A continuous session builds a runner per cycle but must keep one provider
   * for its whole life: proxy and session cooldowns are measured in minutes, so
   * rebuilding them every cycle would silently un-bench every proxy that had
   * just been benched for failing.
   */
  proxyProvider?: ProxyProvider | undefined;
  sessionPool?: SessionPool | undefined;
  /**
   * Notified on every proxy health transition. Ignored when `proxyProvider` is
   * supplied — a caller that brought its own already chose its listener — and
   * never fired in `rotating-residential` mode, which has no health to report.
   */
  onProxyEvent?: ProxyEventListener | undefined;
  /** Successful short-link resolutions shared across continuous-session cycles. */
  resolutionCache?: Map<string, ResolvedUrl> | undefined;
  /**
   * Overrides the transport instead of building `FetchHttpClient` against real
   * proxy/direct dispatchers.
   *
   * Receives the same `bandwidthSink` production wiring already owns, so a
   * substituted transport still feeds real wire-byte accounting into this
   * run's `BandwidthAggregator` rather than leaving it empty. Test/tooling
   * seam only — omitted, the managed production transport is used.
   */
  transport?: ((bandwidthSink: BandwidthSink) => HttpClient) | undefined;
  /** Externally owned connection pools, reused by sequential session cycles. */
  managedTransport?: ManagedHttpTransport | undefined;
}): Promise<BuiltRunner> {
  const { config, logger, sink } = options;
  const concurrency = options.overrides?.concurrency ?? config.concurrency;
  const targetRpm = options.overrides?.targetRpm ?? config.targetRpm;
  const burst = options.overrides?.burst ?? config.burst;
  const httpRpmPerHost = options.overrides?.httpRpmPerHost ?? config.httpRpmPerHost;

  const proxyProvider =
    options.proxyProvider ?? createProxyProvider(config, logger, options.onProxyEvent);
  const sessionPool = options.sessionPool ?? (await createSessionPool(config, logger));
  const metrics = new MetricsCollector();

  // `dispatcherFactory` is consulted only when a request has a proxy assigned,
  // so the direct path needs its own composed dispatcher passed explicitly —
  // otherwise every proxy-less run reports zero bandwidth. Passed explicitly
  // rather than via `setGlobalDispatcher`, which would silently capture
  // traffic elsewhere in the process.
  const bandwidth = config.metricsBandwidth ? new BandwidthAggregator() : null;
  const bandwidthSink: BandwidthSink = bandwidth ?? nullBandwidthSink;

  const ownedTransport =
    options.transport === undefined && options.managedTransport === undefined
      ? createManagedHttpTransport(config, logger)
      : null;
  const managedTransport = options.managedTransport ?? ownedTransport;
  const transport =
    options.transport?.(bandwidthSink) ?? managedTransport?.clientFor(bandwidthSink);
  if (transport === undefined) {
    throw new ScrapeError({ code: 'config_error', message: 'no HTTP transport was configured' });
  }

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

  const retryPolicy = new RetryPolicy({ ...config.retry, ...options.overrides?.retry });
  const runner = new ScrapeRunner({
    scrapers: createDefaultScraperRegistry({ instagram: config.instagram }),
    http,
    proxyProvider,
    sessionPool,
    sink,
    metrics,
    bandwidth,
    retryPolicy,
    logger,
    config: {
      concurrency,
      targetRpm,
      ...(burst > 0 ? { burst } : {}),
      maxQueueSize: config.maxQueueSize,
      attemptTimeoutMsByPlatform: config.attemptTimeoutMsByPlatform,
    },
  });
  const inputPreparer = new InputPreparer({
    resolvers: createDefaultUrlResolverRegistry(),
    http,
    proxyProvider,
    retryPolicy,
    logger,
    metrics,
    concurrency,
    requestTimeoutMs: config.requestTimeoutMs,
    ...(options.resolutionCache === undefined ? {} : { cache: options.resolutionCache }),
  });

  return {
    runner,
    metrics,
    proxyProvider,
    sessionPool,
    normalizers: createDefaultUrlNormalizerRegistry(),
    inputPreparer,
    concurrency,
    targetRpm,
    bandwidth,
    dispose: () => ownedTransport?.close() ?? Promise.resolve(),
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
        ? base.compose(createCountingInterceptor({ sink, proxyId: proxyId(target) }))
        : base;
      proxyAgents.set(target.url, agent);
    }
    return agent;
  };
}

/**
 * The provider plus, when configured, the service that keeps it stocked.
 *
 * Returned together because their lifetimes are the same: the manager holds
 * timers and must be stopped wherever the provider stops being used.
 */
export interface ProxySupply {
  provider: ProxyProvider;
  /** `null` unless `PROXY_SOURCE_URL` is set — and always `null` off `static`. */
  source: ProxySourceManager | null;
}

/**
 * Builds the proxy provider and, if a candidate source is configured, wires it in.
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
  if (config.proxy.mode === 'rotating-residential') {
    // No source, ever: the candidate list, the canary probe and the eviction
    // loop all exist to keep a roster stocked, and a gateway has no roster.
    return { provider: createProxyProvider(config, logger, onProxyEvent), source: null };
  }

  const sourceUrl = config.proxy.source.url;
  const pool = createProxyPool(config, logger, onProxyEvent, sourceUrl !== '');
  if (sourceUrl === '' || !(pool instanceof InMemoryProxyPool)) {
    return { provider: new StaticProxyProvider(pool), source: null };
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
  return { provider: new StaticProxyProvider(pool), source };
}

/**
 * Resolves configuration into the one provider the run goes out through.
 *
 * The single place that decides which proxy implementation is in play. Callers
 * downstream hold a `ProxyProvider` and never ask which kind it is, which is
 * what keeps `PROXY_MODE` from spreading into the runner and the CLI.
 */
export function createProxyProvider(
  config: AppConfig,
  logger: Logger,
  onProxyEvent?: ProxyEventListener,
): ProxyProvider {
  if (config.proxy.mode === 'rotating-residential') {
    return createRotatingResidentialProvider(config, logger);
  }
  return new StaticProxyProvider(createProxyPool(config, logger, onProxyEvent));
}

function createRotatingResidentialProvider(
  config: AppConfig,
  logger: Logger,
): RotatingResidentialProxyProvider {
  const { residential } = config.proxy;
  const target = buildProxyTarget({
    protocol: residential.protocol,
    host: residential.host,
    port: residential.port,
    username: residential.username,
    password: residential.password,
  });

  // Warned rather than rejected. Static settings left in a `.env` are exactly
  // what someone switching modes to compare the two will have, and failing on
  // their mere presence would make that comparison awkward to run.
  if (config.proxy.source.url !== '') {
    logger.warn(
      'PROXY_SOURCE_URL is set but PROXY_MODE is rotating-residential; the candidate source is ignored',
    );
  }
  if (config.proxy.pool !== '') {
    logger.warn(
      'PROXY_POOL is set but PROXY_MODE is rotating-residential; the static pool is ignored',
    );
  }

  const provider = new RotatingResidentialProxyProvider({ target });
  logger.info(
    {
      // The credential-free id, which is the only form of the gateway that is
      // ever logged.
      gateway: provider.id,
      // Not the pool's ceiling: a gateway imposes none of its own, so what
      // bounds the run is the configured concurrency alone.
      concurrency: config.concurrency,
    },
    'rotating residential proxy configured',
  );
  return provider;
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
