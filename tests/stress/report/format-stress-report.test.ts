import { describe, expect, it } from 'vitest';

import { ThroughputTimeline } from '../../../src/core/metrics/throughput-timeline.js';
import { formatStressReport } from '../../../src/stress/report/format-stress-report.js';
import { buildStressReport } from '../../../src/stress/report/stress-report.js';
import { type LoadGeneratorResult } from '../../../src/stress/load-generator/load-generator.js';
import { NORMAL_WORKLOAD_PROFILE } from '../../../src/stress/workload/workload-profile.js';

import { fakePhaseResult } from './report-test-helpers.js';

describe('formatStressReport', () => {
  it('is a pure projection: same report in, same text out', () => {
    const result: LoadGeneratorResult = {
      plan: { profile: 'acceptance', workload: NORMAL_WORKLOAD_PROFILE, phases: [] },
      phases: [
        fakePhaseResult('acceptance', { requests: 100, successes: 98, failures: 2, targetRpm: 0 }),
      ],
      timeline: new ThroughputTimeline({ startedAtMs: 0 }),
      timelineSamples: [],
      queueSamples: [],
      memorySamples: [],
      startedAt: new Date(0),
      finishedAt: new Date(60_000),
      snapshotsPath: '/tmp/x.jsonl',
    };
    const report = buildStressReport(result);

    const first = formatStressReport(report);
    const second = formatStressReport(report);

    expect(first).toBe(second);
    expect(first).toContain('Stress Test');
    expect(first).toContain('Result: PASS');
    expect(first).toContain('Jobs submitted');
    expect(first).toContain('Actual throughput');
  });

  it('shows the verdict and findings for a failing report', () => {
    const result: LoadGeneratorResult = {
      plan: { profile: 'acceptance', workload: NORMAL_WORKLOAD_PROFILE, phases: [] },
      phases: [
        fakePhaseResult('acceptance', {
          requests: 100,
          successes: 40,
          failures: 60,
          poolExhausted: 1,
          targetRpm: 500,
        }),
      ],
      timeline: new ThroughputTimeline({ startedAtMs: 0 }),
      timelineSamples: [],
      queueSamples: [],
      memorySamples: [],
      startedAt: new Date(0),
      finishedAt: new Date(60_000),
      snapshotsPath: '/tmp/x.jsonl',
    };
    const report = buildStressReport(result);

    const text = formatStressReport(report);

    expect(text).toContain('Result: FAIL');
    expect(text).toContain('Findings');
    expect(text).toContain('proxy_exhaustion');
  });
});
