import { describe, expect, it } from 'vitest';

import {
  ACCEPTANCE_DURATION_MS,
  ACCEPTANCE_TARGET_RPM,
  buildStressPlan,
  STRESS_PROFILE_NAMES,
} from '../../../src/stress/load-generator/profiles.js';

describe('buildStressPlan', () => {
  it.each(STRESS_PROFILE_NAMES)(
    '%s produces at least one phase, all with the requested platform',
    (profile) => {
      const plan = buildStressPlan({ profile, platform: 'mixed', concurrency: 10 });

      expect(plan.phases.length).toBeGreaterThan(0);
      expect(plan.phases.every((phase) => phase.platform === 'mixed')).toBe(true);
    },
  );

  it('acceptance uses the exact specification.txt §6 numbers by default', () => {
    const plan = buildStressPlan({ profile: 'acceptance', platform: 'tiktok', concurrency: 25 });

    expect(plan.phases).toHaveLength(1);
    expect(plan.phases[0]?.targetRpm).toBe(ACCEPTANCE_TARGET_RPM);
    expect(plan.phases[0]?.durationMs).toBe(ACCEPTANCE_DURATION_MS);
  });

  it('explicit overrides win over profile defaults', () => {
    const plan = buildStressPlan({
      profile: 'acceptance',
      platform: 'tiktok',
      concurrency: 25,
      targetRpm: 123,
      durationMs: 45_000,
    });

    expect(plan.phases[0]?.targetRpm).toBe(123);
    expect(plan.phases[0]?.durationMs).toBe(45_000);
  });

  it('rampUpMs prepends a climbing staircase before the steady phase', () => {
    const plan = buildStressPlan({
      profile: 'acceptance',
      platform: 'tiktok',
      concurrency: 25,
      targetRpm: 500,
      rampUpMs: 50_000,
    });

    // 5 ramp steps + the steady phase.
    expect(plan.phases).toHaveLength(6);
    const rampRates = plan.phases.slice(0, 5).map((phase) => phase.targetRpm);
    expect(rampRates).toEqual([...rampRates].sort((a, b) => a - b));
    expect(rampRates[rampRates.length - 1]).toBeLessThanOrEqual(500);
    expect(plan.phases[5]?.targetRpm).toBe(500);
    expect(plan.phases[5]?.name).toBe('acceptance');
  });

  it('omitting rampUpMs (or 0) produces just the steady phase', () => {
    const plan = buildStressPlan({
      profile: 'acceptance',
      platform: 'tiktok',
      concurrency: 25,
      rampUpMs: 0,
    });
    expect(plan.phases).toHaveLength(1);
  });

  it('burst is warmup -> unpaced flood -> recovery, never a ramp', () => {
    const plan = buildStressPlan({ profile: 'burst', platform: 'tiktok', concurrency: 10 });

    expect(plan.phases.map((phase) => phase.name)).toEqual(['warmup', 'burst', 'recovery']);
    const burstPhase = plan.phases[1];
    expect(burstPhase?.targetRpm).toBe(0);
    expect(burstPhase?.totalJobs).toBeGreaterThan(0);
  });

  it('failure-heavy defaults to the failure-heavy workload profile', () => {
    const plan = buildStressPlan({ profile: 'failure-heavy', platform: 'tiktok', concurrency: 10 });
    const { normal = 0, ...failureWeights } = plan.workload.tiktok.scenarios;
    const failureTotal = Object.values(failureWeights).reduce(
      (sum, weight) => sum + (weight ?? 0),
      0,
    );
    expect(failureTotal).toBeGreaterThan(normal);
  });

  it('a supplied workload profile overrides the profile default', () => {
    const customWorkload = {
      seed: 999,
      tiktok: {
        scenarios: { normal: 1 },
        retryFailFirstN: 1,
        latency: { minMs: 0, maxMs: 0 },
        responseSize: { targetBytes: 1_000 },
      },
      instagram: {
        scenarios: { fast_path: 1 },
        clipsMaxPages: 2,
        clipsMaxAuthors: 3,
        latency: { minMs: 0, maxMs: 0 },
        responseSize: { targetBytes: 1_000 },
      },
    };
    const plan = buildStressPlan({
      profile: 'baseline',
      platform: 'tiktok',
      concurrency: 5,
      workload: customWorkload,
    });
    expect(plan.workload).toBe(customWorkload);
  });
});
