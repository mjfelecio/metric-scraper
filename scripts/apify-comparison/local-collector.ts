import { nullLogger, type Logger } from '../../src/core/logging/logger.js';
import { isScrapeSuccess } from '../../src/core/models/scrape-result.js';
import {
  createFailureSnapshot,
  createSuccessSnapshot,
  type MetricSnapshot,
} from '../../src/core/models/snapshot.js';
import { ScrapeError } from '../../src/core/models/errors.js';
import { type ScrapeContext } from '../../src/core/scraper/scrape-context.js';
import { type Scraper } from '../../src/core/scraper/scraper.js';

import { type CountingHttpClient } from './counting-http-client.js';
import { EMPTY_METRICS, type BenchmarkTarget, type SourceObservation } from './types.js';

export interface LocalCollectorOptions {
  readonly scraper: Scraper;
  /** Already wrapped in `CountingHttpClient` by the caller when bytes matter. */
  readonly http: CountingHttpClient;
  readonly timeoutMs: number;
  readonly logger?: Logger | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface LocalCollectionResult {
  readonly observations: readonly SourceObservation[];
  /** Real `MetricSnapshot` rows, so the artifact matches production output. */
  readonly snapshots: readonly MetricSnapshot[];
  readonly totalBytes: number;
  readonly totalRequests: number;
}

/**
 * Runs the production TikTok scraper once per target.
 *
 * Calls `Scraper.scrape` directly rather than going through `ScrapeRunner`,
 * for two reasons: the benchmark needs one clean attempt per URL with no retry
 * chain folded into the latency it reports, and it needs bytes attributed to a
 * single target, which a concurrent runner cannot give it. The scraper itself
 * — the thing under comparison — is exactly the production one.
 *
 * Sequential on purpose. Four URLs is not a throughput test, and running them
 * one at a time keeps each latency and byte count attributable.
 */
export async function collectLocally(
  targets: readonly BenchmarkTarget[],
  options: LocalCollectorOptions,
): Promise<LocalCollectionResult> {
  const logger = options.logger ?? nullLogger;
  const now = options.now ?? ((): Date => new Date());

  const observations: SourceObservation[] = [];
  const snapshots: MetricSnapshot[] = [];
  let totalBytes = 0;
  let totalRequests = 0;

  for (const target of targets) {
    options.http.reset();
    const startedAt = now();
    const startedMs = Date.now();
    const timeout = AbortSignal.timeout(options.timeoutMs);

    const context: ScrapeContext = {
      attempt: 1,
      maxAttempts: 1,
      signal: timeout,
      http: options.http,
      proxy: null,
      session: null,
      logger,
      runCache: new Map<string, unknown>(),
      now,
    };

    let snapshot: MetricSnapshot;
    try {
      const result = await options.scraper.scrape(target.url, context);
      const latencyMs = Date.now() - startedMs;
      const snapshotContext = {
        platform: 'tiktok' as const,
        url: target.url,
        scrapedAt: startedAt,
        latencyMs,
      };
      snapshot = isScrapeSuccess(result)
        ? createSuccessSnapshot(snapshotContext, result.data)
        : createFailureSnapshot(snapshotContext, result.status, result.error, result.partial);
    } catch (error) {
      // A throw from a scraper is a bug or a transport failure, never a reason
      // to lose the row: the benchmark reports it as this source's failure and
      // carries on to the next target.
      const scrapeError = ScrapeError.from(error);
      snapshot = createFailureSnapshot(
        {
          platform: 'tiktok',
          url: target.url,
          scrapedAt: startedAt,
          latencyMs: Date.now() - startedMs,
        },
        scrapeError.status === 'ok' ? 'error' : scrapeError.status,
        scrapeError.toInfo(),
        { video_id: target.videoId },
      );
    }

    const measured = options.http.snapshot();
    totalBytes += measured.bytes;
    totalRequests += measured.requests;

    snapshots.push(snapshot);
    observations.push(toObservation(target, snapshot, measured.bytes));
  }

  return { observations, snapshots, totalBytes, totalRequests };
}

function toObservation(
  target: BenchmarkTarget,
  snapshot: MetricSnapshot,
  bytes: number,
): SourceObservation {
  const ok = snapshot.status === 'ok';
  return {
    videoId: snapshot.video_id ?? target.videoId,
    ok,
    // A failed scrape reports no metrics at all. Carrying whatever partial the
    // scraper salvaged into a comparison would compare a guess with a fact.
    metrics: ok
      ? {
          ...EMPTY_METRICS,
          views: snapshot.views,
          likes: snapshot.likes,
          comments: snapshot.comments,
          shares: snapshot.shares,
          saves: snapshot.saves,
          authorHandle: snapshot.author_handle,
          authorFollowerCount: snapshot.author_follower_count,
          postedAt: snapshot.posted_at,
        }
      : EMPTY_METRICS,
    observedAt: snapshot.scraped_at,
    latencyMs: snapshot.latency_ms,
    error: snapshot.error,
    responseBytes: bytes,
  };
}
