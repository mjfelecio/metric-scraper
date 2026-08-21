import { type RunSummary } from '../../../src/core/models/run-summary.js';
import { type PhaseResult } from '../../../src/stress/load-generator/load-generator.js';
import { type StressPhase } from '../../../src/stress/load-generator/profiles.js';

export function fakeSummary(
  params: {
    requests?: number;
    successes?: number;
    failures?: number;
    retries?: number;
    rateLimited?: number;
    platformHttpRequests?: number;
    poolExhausted?: number;
    cooling?: number;
    retired?: number;
    configuredProxies?: number;
    targetRpm?: number;
    requestsPerMinute?: number;
    bandwidthRequests?: number;
    bandwidthBytes?: number;
  } = {},
): RunSummary {
  const requests = params.requests ?? 100;
  const successes = params.successes ?? requests;
  const failures = params.failures ?? requests - successes;
  const configured = params.configuredProxies ?? 1;

  return {
    run_id: 'stress-test-run',
    platform: 'tiktok',
    started_at: new Date(0).toISOString(),
    finished_at: new Date(1_000).toISOString(),
    duration_ms: 1_000,
    input: { candidates: requests, accepted: requests, rejected: 0 },
    totals: {
      requests,
      platform_http_requests: params.platformHttpRequests ?? requests * 2,
      successes,
      failures,
      success_rate: requests > 0 ? successes / requests : 0,
    },
    throughput: {
      requests_per_minute: params.requestsPerMinute ?? requests * 60,
      target_rpm: params.targetRpm ?? 0,
      concurrency: {
        configured: 10,
        max_observed: 10,
        effective: 5,
        utilization: 1,
        saturated: true,
        achievable: 10,
        ceilings: { configured: 10, input: requests, admission: 10, proxy: configured, http: null },
        minimum_proxy_capacity: configured,
        findings: [],
      },
    },
    bandwidth:
      params.bandwidthRequests === undefined
        ? null
        : {
            requests: params.bandwidthRequests,
            request_bytes: Math.floor((params.bandwidthBytes ?? 0) / 2),
            response_bytes: Math.ceil((params.bandwidthBytes ?? 0) / 2),
            total_bytes: params.bandwidthBytes ?? 0,
            bytes_per_request:
              params.bandwidthRequests > 0
                ? (params.bandwidthBytes ?? 0) / params.bandwidthRequests
                : null,
          },
    queue: {
      max_depth: 0,
      wait_count: 0,
      wait_total_ms: 0,
      wait_mean_ms: 0,
      wait_p50_ms: 0,
      wait_p95_ms: 0,
      wait_max_ms: 0,
    },
    waits: {
      admission_total_ms: 0,
      http_rate_limit_total_ms: 0,
      proxy_acquire_total_ms: 0,
      retry_backoff_total_ms: 0,
      admission_ms: 0,
      http_rate_limit_ms: 0,
      proxy_acquire_ms: 0,
      retry_backoff_ms: 0,
    },
    latency: { count: requests, p50_ms: 100, p95_ms: 200, max_ms: 300, mean_ms: 120 },
    status_breakdown: {
      ok: successes,
      not_found: 0,
      private: 0,
      rate_limited: params.rateLimited ?? 0,
      error: Math.max(0, failures - (params.rateLimited ?? 0)),
    },
    error_breakdown: {},
    retries: {
      total_retries: params.retries ?? 0,
      retried_requests: params.retries ?? 0,
      exhausted_requests: 0,
    },
    proxies: {
      mode: 'static',
      configured,
      used: configured,
      available: configured,
      untested: 0,
      cooling: params.cooling ?? 0,
      saturated: 0,
      blocked: 0,
      retired: params.retired ?? 0,
      total_in_flight: 0,
      capacity: configured,
      pool_exhausted: params.poolExhausted ?? 0,
      total_failures: failures,
      eviction_count: 0,
      source: null,
      per_proxy: [],
    },
    sessions: { configured: 0, used: 0, blocked: 0, total_failures: 0, per_session: [] },
    output: { snapshots_path: null, summary_path: null, rows_written: requests },
  };
}

export function fakePhaseResult(
  name: string,
  summaryParams: Parameters<typeof fakeSummary>[0] = {},
  phaseOverrides: Partial<StressPhase> = {},
): PhaseResult {
  const summary = fakeSummary(summaryParams);
  return {
    phase: { name, platform: 'tiktok', targetRpm: summaryParams.targetRpm ?? 0, ...phaseOverrides },
    index: 0,
    runId: summary.run_id,
    summary,
    fatalError: null,
    startedAt: new Date(0),
    finishedAt: new Date(1_000),
  };
}
