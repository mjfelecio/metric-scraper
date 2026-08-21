import { describe, expect, it } from 'vitest';

import {
  ThroughputTimeline,
  type TimelineCounts,
} from '../../../src/core/metrics/throughput-timeline.js';
import { buildStressReport } from '../../../src/stress/report/stress-report.js';
import {
  type LoadGeneratorResult,
  type QueueSample,
  type MemorySample,
} from '../../../src/stress/load-generator/load-generator.js';
import { type StressPlan } from '../../../src/stress/load-generator/profiles.js';
import { NORMAL_WORKLOAD_PROFILE } from '../../../src/stress/workload/workload-profile.js';

import { fakePhaseResult } from './report-test-helpers.js';

function fakeTimeline(): {
  timeline: ThroughputTimeline;
  advance: (ms: number) => void;
  feed: (counts: Partial<TimelineCounts>) => void;
} {
  let current = 0;
  const timeline = new ThroughputTimeline({ startedAtMs: 0, now: () => current });
  return {
    timeline,
    advance: (ms: number) => {
      current += ms;
    },
    feed: (counts: Partial<TimelineCounts>) => {
      timeline.record({
        completed: 0,
        successes: 0,
        failures: 0,
        retries: 0,
        inFlight: 0,
        cycle: 0,
        bytes: 0,
        ...counts,
      });
    },
  };
}

function baseResult(overrides: Partial<LoadGeneratorResult> = {}): LoadGeneratorResult {
  const plan: StressPlan = { profile: 'acceptance', workload: NORMAL_WORKLOAD_PROFILE, phases: [] };
  const { timeline } = fakeTimeline();
  return {
    plan,
    // targetRpm 0 by default so unrelated tests don't accidentally trip the
    // acceptance profile's default sustained-throughput requirement; tests
    // that specifically exercise throughput_below_target set their own
    // phases/timeline/targetRpm explicitly.
    phases: [fakePhaseResult('acceptance', { requests: 100, targetRpm: 0 })],
    timeline,
    timelineSamples: [],
    queueSamples: [],
    memorySamples: [],
    startedAt: new Date(0),
    finishedAt: new Date(60_000),
    snapshotsPath: '/tmp/does-not-matter.jsonl',
    ...overrides,
  };
}

describe('buildStressReport: throughput_below_target', () => {
  it('FAILs when the acceptance profile never sustains target rpm for the required window', () => {
    const { timeline, advance, feed } = fakeTimeline();
    // Only ever hits 300rpm, well under a 500rpm target.
    for (let second = 1; second <= 5; second += 1) {
      advance(1_000);
      feed({ completed: second * 5 }); // 5/sec = 300rpm
    }
    const result = baseResult({
      timeline,
      phases: [fakePhaseResult('acceptance', { requests: 25, targetRpm: 500 })],
    });

    const report = buildStressReport(result, { requiredSustainedMs: 4_000 });

    expect(report.findings.some((finding) => finding.kind === 'throughput_below_target')).toBe(
      true,
    );
    expect(report.verdict).toBe('FAIL');
  });

  it('PASSes when the target rpm is sustained for at least the required window', () => {
    const { timeline, advance, feed } = fakeTimeline();
    // 10/sec = 600rpm, comfortably above a 500rpm target, for 5 seconds.
    for (let second = 1; second <= 5; second += 1) {
      advance(1_000);
      feed({ completed: second * 10 });
    }
    const result = baseResult({
      timeline,
      phases: [fakePhaseResult('acceptance', { requests: 50, successes: 50, targetRpm: 500 })],
    });

    const report = buildStressReport(result, { requiredSustainedMs: 4_000 });

    expect(report.findings.some((finding) => finding.kind === 'throughput_below_target')).toBe(
      false,
    );
    expect(report.verdict).toBe('PASS');
  });

  it("defaults the acceptance profile's required window to the phase's OWN configured duration, not always 10 minutes", () => {
    // A quick `--duration 15s` dev smoke check must be judged against 15s,
    // not silently against the spec's full 600s -- otherwise a healthy
    // system always reports FAIL on a short run.
    const result = baseResult({
      phases: [
        fakePhaseResult('acceptance', { requests: 10, targetRpm: 500 }, { durationMs: 15_000 }),
      ],
    });

    const report = buildStressReport(result);

    expect(report.requiredSustainedMs).toBe(15_000);
  });

  it('is not evaluated for profiles with no requiredSustainedMs (e.g. baseline)', () => {
    const result = baseResult({
      plan: { profile: 'baseline', workload: NORMAL_WORKLOAD_PROFILE, phases: [] },
      phases: [fakePhaseResult('baseline', { requests: 10, targetRpm: 30 })],
    });

    const report = buildStressReport(result);

    expect(report.requiredSustainedMs).toBeNull();
    expect(report.findings.some((finding) => finding.kind === 'throughput_below_target')).toBe(
      false,
    );
  });
});

describe('buildStressReport: retry_storm', () => {
  it('FAILs when retries exceed the configured ratio of submitted jobs', () => {
    const result = baseResult({
      phases: [
        fakePhaseResult('acceptance', { requests: 100, successes: 100, retries: 80, targetRpm: 0 }),
      ],
    });

    const report = buildStressReport(result);

    expect(report.findings.some((finding) => finding.kind === 'retry_storm')).toBe(true);
    expect(report.verdict).toBe('FAIL');
  });

  it('does not fire under the threshold', () => {
    const result = baseResult({
      phases: [
        fakePhaseResult('acceptance', { requests: 100, successes: 100, retries: 10, targetRpm: 0 }),
      ],
    });

    const report = buildStressReport(result);

    expect(report.findings.some((finding) => finding.kind === 'retry_storm')).toBe(false);
  });
});

describe('buildStressReport: excessive_rate_limiting', () => {
  it('FAILs when rate-limited responses exceed the configured ratio', () => {
    const result = baseResult({
      phases: [
        fakePhaseResult('acceptance', {
          requests: 100,
          successes: 50,
          failures: 50,
          rateLimited: 20,
          targetRpm: 0,
        }),
      ],
    });

    const report = buildStressReport(result);

    expect(report.findings.some((finding) => finding.kind === 'excessive_rate_limiting')).toBe(
      true,
    );
  });
});

describe('buildStressReport: proxy_exhaustion', () => {
  it('FAILs when the pool was ever fully exhausted', () => {
    const result = baseResult({
      phases: [fakePhaseResult('acceptance', { requests: 100, poolExhausted: 3, targetRpm: 0 })],
    });

    const report = buildStressReport(result);

    expect(report.findings.some((finding) => finding.kind === 'proxy_exhaustion')).toBe(true);
  });

  it('FAILs when a majority of proxies are cooling or retired', () => {
    const result = baseResult({
      phases: [
        fakePhaseResult('acceptance', {
          requests: 100,
          configuredProxies: 10,
          cooling: 4,
          retired: 3,
          targetRpm: 0,
        }),
      ],
    });

    const report = buildStressReport(result);

    expect(report.findings.some((finding) => finding.kind === 'proxy_exhaustion')).toBe(true);
  });

  it('does not fire for a healthy pool', () => {
    const result = baseResult({
      phases: [
        fakePhaseResult('acceptance', {
          requests: 100,
          configuredProxies: 10,
          cooling: 1,
          retired: 0,
          targetRpm: 0,
        }),
      ],
    });

    const report = buildStressReport(result);

    expect(report.findings.some((finding) => finding.kind === 'proxy_exhaustion')).toBe(false);
  });
});

describe('buildStressReport: unbounded_queue_growth', () => {
  function queueSamples(pattern: readonly { queued: number; inFlight: number }[]): QueueSample[] {
    return pattern.map((row, index) => ({
      tMs: index * 100,
      phaseIndex: 0,
      queued: row.queued,
      inFlight: row.inFlight,
      concurrency: 10,
    }));
  }

  it('FAILs when queue depth grows and consumers stay pinned at concurrency', () => {
    const growing = [
      ...Array.from({ length: 10 }, () => ({ queued: 2, inFlight: 10 })),
      ...Array.from({ length: 10 }, () => ({ queued: 4, inFlight: 10 })),
      ...Array.from({ length: 10 }, () => ({ queued: 30, inFlight: 10 })),
    ];
    const result = baseResult({ queueSamples: queueSamples(growing) });

    const report = buildStressReport(result);

    expect(report.findings.some((finding) => finding.kind === 'unbounded_queue_growth')).toBe(true);
  });

  it('does not fire when the queue grows but consumers are not saturated (admission caught up)', () => {
    const notBackedUp = [
      ...Array.from({ length: 10 }, () => ({ queued: 2, inFlight: 10 })),
      ...Array.from({ length: 10 }, () => ({ queued: 4, inFlight: 5 })),
      ...Array.from({ length: 10 }, () => ({ queued: 30, inFlight: 2 })),
    ];
    const result = baseResult({ queueSamples: queueSamples(notBackedUp) });

    const report = buildStressReport(result);

    expect(report.findings.some((finding) => finding.kind === 'unbounded_queue_growth')).toBe(
      false,
    );
  });

  it('does not fire on a stable queue', () => {
    const stable = Array.from({ length: 30 }, () => ({ queued: 3, inFlight: 10 }));
    const result = baseResult({ queueSamples: queueSamples(stable) });

    const report = buildStressReport(result);

    expect(report.findings.some((finding) => finding.kind === 'unbounded_queue_growth')).toBe(
      false,
    );
  });
});

describe('buildStressReport: memory_growth', () => {
  function memorySamples(values: readonly number[]): MemorySample[] {
    return values.map((rssBytes, index) => ({ tMs: index * 1_000, rssBytes }));
  }

  it('is a warn-only finding and never fails the verdict by itself', () => {
    const growing = [
      ...Array.from({ length: 10 }, () => 100_000_000),
      ...Array.from({ length: 10 }, () => 120_000_000),
      ...Array.from({ length: 10 }, () => 250_000_000),
    ];
    const result = baseResult({ memorySamples: memorySamples(growing) });

    const report = buildStressReport(result);
    const finding = report.findings.find((entry) => entry.kind === 'memory_growth');

    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('warn');
    expect(report.verdict).toBe('PASS');
  });

  it('does not fire on stable memory', () => {
    const stable = Array.from({ length: 30 }, () => 100_000_000);
    const result = baseResult({ memorySamples: memorySamples(stable) });

    const report = buildStressReport(result);

    expect(report.findings.some((finding) => finding.kind === 'memory_growth')).toBe(false);
  });
});

describe('buildStressReport: aggregation', () => {
  it("sums counts across phases but reports the final phase's own latency/proxies", () => {
    const result = baseResult({
      phases: [
        fakePhaseResult('ramp-1', { requests: 10, successes: 10, retries: 1, targetRpm: 100 }),
        fakePhaseResult('acceptance', {
          requests: 90,
          successes: 85,
          failures: 5,
          retries: 2,
          targetRpm: 500,
        }),
      ],
    });

    const report = buildStressReport(result);

    expect(report.totals.submitted).toBe(100);
    expect(report.totals.successes).toBe(95);
    expect(report.totals.retries).toBe(3);
    expect(report.targetRpm).toBe(500);
  });

  it('sums bandwidth across phases when present', () => {
    const result = baseResult({
      phases: [
        fakePhaseResult('a', { bandwidthRequests: 10, bandwidthBytes: 1_000 }),
        fakePhaseResult('b', { bandwidthRequests: 20, bandwidthBytes: 2_000 }),
      ],
    });

    const report = buildStressReport(result);

    expect(report.bandwidth?.requests).toBe(30);
    expect(report.bandwidth?.totalBytes).toBe(3_000);
  });

  it('reports a fatal_error finding and FAILs when any phase ended fatally', () => {
    const phase = fakePhaseResult('acceptance', { requests: 10, targetRpm: 0 });
    phase.fatalError = 'unwritable output';
    const result = baseResult({ phases: [phase] });

    const report = buildStressReport(result);

    expect(report.findings.some((finding) => finding.kind === 'fatal_error')).toBe(true);
    expect(report.verdict).toBe('FAIL');
  });
});
