import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CAPACITY_INPUTS,
  simulateCapacity,
  type CapacityInputs,
} from '../../src/core/capacity/index.js';

function withInput(patch: Partial<CapacityInputs>): CapacityInputs {
  return { ...DEFAULT_CAPACITY_INPUTS, ...patch };
}

describe('capacity calculator', () => {
  it('reproduces the approved deterministic baseline', () => {
    const result = simulateCapacity(DEFAULT_CAPACITY_INPUTS);
    expect(result.valid).toBe(true);
    expect(result.workload.activeSubmissionsAtRunRate).toBe(15_000);
    expect(result.workload.polledSubmissionsAtRunRate).toBe(10_500);
    expect(result.traffic.logicalJobsPerDay).toBe(350_000);
    expect(result.timeline[0]?.scrapeJobs).toBe(48_000);
    expect(result.timeline[6]?.scrapeJobs).toBe(336_000);
    expect(result.timeline[20]?.scrapeJobs).toBe(350_000);
    expect(result.concurrency.averageJobs.computable).toBe(true);
    if (result.concurrency.averageJobs.computable) {
      expect(result.concurrency.averageJobs.value).toBeCloseTo(29.7, 1);
    }
    expect(result.proxy.theoreticalProxies).toEqual({ computable: true, value: 4 });
    expect(result.proxy.recommendedProxies).toEqual({ computable: true, value: 5 });
    expect(result.bandwidth.baselineGbPerDay).toEqual({ computable: true, value: 17.85 });
    expect(result.bandwidth.baselineGbPerMonth).toEqual({ computable: true, value: 535.5 });
    if (result.bandwidth.adjustedGbPerDay.computable) {
      expect(result.bandwidth.adjustedGbPerDay.value).toBeCloseTo(18.02, 2);
    }
  });

  it('keeps steady-state month rates separate from horizon totals', () => {
    const result = simulateCapacity(withInput({ horizonDays: 1 }));
    expect(result.traffic.logicalJobsPerMonth).toBe(10_500_000);
    expect(result.traffic.logicalJobsInHorizon).toBe(48_000);
  });

  it('makes measurement-dependent results unavailable instead of zero', () => {
    const result = simulateCapacity(
      withInput({
        requestsPerJob: null,
        bytesPerHttpRequest: null,
        meanJobLatencyMs: null,
        p95JobLatencyMs: null,
      }),
    );
    expect(result.traffic.baselineHttpRequestsPerDay.computable).toBe(false);
    expect(result.bandwidth.baselineGbPerDay.computable).toBe(false);
    expect(result.concurrency.averageJobs.computable).toBe(false);
  });

  it('applies Little’s Law independently to jobs and HTTP requests', () => {
    const result = simulateCapacity(
      withInput({ meanHttpLatencyMs: 1_000, p95HttpLatencyMs: 2_000 }),
    );
    expect(result.concurrency.averageJobs.computable).toBe(true);
    expect(result.concurrency.averageHttpRequests.computable).toBe(true);
    if (result.concurrency.averageHttpRequests.computable) {
      expect(result.concurrency.averageHttpRequests.value).toBeCloseTo(8.18, 1);
    }
  });

  it('uses the explicit peak override before the multiplier', () => {
    const result = simulateCapacity(
      withInput({
        capacity: {
          ...DEFAULT_CAPACITY_INPUTS.capacity,
          peakMultiplier: 99,
          peakJobsPerMinuteOverride: 123,
        },
      }),
    );
    expect(result.peak).toMatchObject({ jobsPerMinute: 123, source: 'override' });
  });

  it('selects the strongest proxy constraint before applying margin', () => {
    const result = simulateCapacity(
      withInput({
        capacity: {
          ...DEFAULT_CAPACITY_INPUTS.capacity,
          proxyLimits: {
            ...DEFAULT_CAPACITY_INPUTS.capacity.proxyLimits,
            maxConcurrentPerProxy: 100,
            maxRequestsPerMinutePerProxy: 100,
            maxBytesPerMonthPerProxy: 1_000_000_000_000,
          },
          safetyMargin: 0.2,
        },
      }),
    );
    expect(result.proxy.bindingConstraint).toBe('http-rpm');
    expect(result.proxy.theoreticalProxies).toEqual({ computable: true, value: 5 });
    expect(result.proxy.recommendedProxies).toEqual({ computable: true, value: 6 });
  });

  it('distinguishes free prices from missing prices', () => {
    const missing = simulateCapacity(DEFAULT_CAPACITY_INPUTS);
    expect(missing.cost.totalMonthly.computable).toBe(false);
    const free = simulateCapacity(
      withInput({
        pricing: {
          ...DEFAULT_CAPACITY_INPUTS.pricing,
          pricePerGb: 0,
          fixedMonthlyPerProxy: 0,
          fixedMonthlyPool: 0,
        },
      }),
    );
    expect(free.cost.totalMonthly).toEqual({ computable: true, value: 0 });
  });

  it('compounds growth with month one as baseline', () => {
    const result = simulateCapacity(
      withInput({ growth: { enabled: true, monthlyGrowthRate: 0.1, months: 3 } }),
    );
    expect(result.growth[0]?.factor).toBe(1);
    expect(result.growth[1]?.factor).toBeCloseTo(1.1, 10);
    expect(result.growth[2]?.factor).toBeCloseTo(1.21, 10);
  });

  it('reports worker ceilings against process-local aggregate capacity', () => {
    const result = simulateCapacity(DEFAULT_CAPACITY_INPUTS);
    expect(result.workers.aggregateJobConcurrency).toBe(10);
    expect(result.workers.requiredByConcurrency).toEqual({ computable: true, value: 3 });
    expect(result.workers.requiredByHttpEgress).toEqual({ computable: true, value: 2 });
  });
});
