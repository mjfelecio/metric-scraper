import { type MockAgent } from 'undici';

import { BandwidthAggregator } from '../../../src/core/metrics/bandwidth.js';
import { nullLogger } from '../../../src/core/logging/logger.js';
import { type HttpClient } from '../../../src/core/scraper/http-port.js';
import { type ScrapeContext } from '../../../src/core/scraper/scrape-context.js';
import { FetchHttpClient } from '../../../src/infrastructure/http/fetch-http-client.js';
import {
  createMockDefaultDispatcher,
  type RequestTimingLookupInput,
} from '../../../src/stress/upstream/proxy-mock-dispatcher.js';

export interface StressHttpFixture {
  http: HttpClient;
  bandwidth: BandwidthAggregator;
}

/**
 * Wires a direct (no-proxy) `FetchHttpClient` to a `MockAgent`, exactly as
 * `composition.ts`'s `transport` seam would for a proxy-less request -- the
 * shape every Phase 1 test scrapes through.
 */
export function buildStressHttpClient(
  mockAgent: MockAgent,
  latencyMs: (opts: RequestTimingLookupInput) => number,
): StressHttpFixture {
  const bandwidth = new BandwidthAggregator();
  const dispatcher = createMockDefaultDispatcher(mockAgent, bandwidth, latencyMs);
  const http = new FetchHttpClient({ defaultTimeoutMs: 5_000, defaultDispatcher: dispatcher });
  return { http, bandwidth };
}

export function stressContext(
  http: HttpClient,
  overrides: Partial<ScrapeContext> = {},
): ScrapeContext {
  return {
    attempt: 1,
    maxAttempts: 3,
    signal: new AbortController().signal,
    http,
    proxy: null,
    session: null,
    logger: nullLogger,
    runCache: new Map<string, unknown>(),
    now: () => new Date('2026-08-21T00:00:00.000Z'),
    ...overrides,
  };
}
