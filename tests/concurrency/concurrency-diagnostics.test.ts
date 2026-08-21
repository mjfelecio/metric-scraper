import { describe, expect, it, vi } from 'vitest';

import {
  ConcurrencyMonitor,
  evaluateConcurrency,
} from '../../src/core/concurrency/concurrency-diagnostics.js';
import { formatConcurrencyFinding } from '../../src/core/concurrency/format-concurrency-finding.js';
import { nullLogger } from '../../src/core/logging/logger.js';

const base = {
  configuredConcurrency: 10,
  acceptedJobs: 100,
  resolvedAdmissionBurst: 10,
  targetRpm: 600,
  meanLatencyMs: 1_000,
  admissionWaitMs: 0,
  observedConcurrency: 10,
  queueDemand: 10,
  proxyMode: 'static' as const,
  proxyCapacity: 20,
};

describe('evaluateConcurrency', () => {
  it.each([
    ['small input', { acceptedJobs: 3 }, 3, ['small_input']],
    [
      'admission pacing',
      { resolvedAdmissionBurst: 2, targetRpm: 60, admissionWaitMs: 100, observedConcurrency: 2 },
      2,
      ['admission_limited'],
    ],
    ['known proxy capacity', { proxyCapacity: 4 }, 4, ['proxy_capacity_limited']],
    [
      'unknown residential capacity',
      { proxyMode: 'rotating-residential' as const, proxyCapacity: null },
      10,
      ['proxy_capacity_unknown'],
    ],
    ['healthy saturation', {}, 10, []],
    ['serialization', { observedConcurrency: 8 }, 10, ['serialized']],
    ['empty run', { acceptedJobs: 0, observedConcurrency: 0, queueDemand: 0 }, 0, ['small_input']],
  ])('%s', (_name, overrides, achievable, codes) => {
    const result = evaluateConcurrency({ ...base, ...overrides });
    expect(result.achievable).toBe(achievable);
    expect(result.findings.map(({ code }) => code)).toEqual(codes);
  });

  it('never lowers the admission ceiling below observed concurrency', () => {
    expect(
      evaluateConcurrency({
        ...base,
        resolvedAdmissionBurst: 1,
        targetRpm: 1,
        observedConcurrency: 7,
      }).ceilings.admission,
    ).toBe(7);
  });
});

describe('ConcurrencyMonitor', () => {
  it('warns at startup, after a material drop, and after recovery and re-entry', () => {
    const warn = vi.fn();
    const logger = { ...nullLogger, warn };
    const monitor = new ConcurrencyMonitor({
      configuredConcurrency: 10,
      acceptedJobs: 10,
      proxyMode: 'static',
      logger,
    });
    monitor.observe(8);
    monitor.observe(7); // less than 20% of demand
    monitor.observe(6);
    monitor.observe(10); // recovery
    monitor.observe(9);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      configured_concurrency: 10,
      input_demand: 10,
      known_capacity: 8,
      proxy_mode: 'static',
      achievable_concurrency: 8,
    });
    expect(monitor.minimumObservedProxyCapacity).toBe(6);
  });
});

describe('formatConcurrencyFinding', () => {
  const concurrency = {
    configured: 10,
    max_observed: 4,
    effective: 3.5,
    utilization: 0.4,
    saturated: false,
    achievable: 5,
    ceilings: { configured: 10, input: 8, admission: 6, proxy: 5 },
    minimum_proxy_capacity: 5,
    findings: [],
  };

  it.each([
    ['small_input', /Input bounds concurrency/],
    ['admission_limited', /admission ceiling 6/],
    ['proxy_capacity_limited', /known capacity 5/],
    ['serialized', /Concurrency underused/],
    ['proxy_capacity_unknown', /capacity: unknown/],
  ] as const)('formats %s consistently', (code, expected) => {
    expect(
      formatConcurrencyFinding(
        {
          code,
          severity:
            code === 'small_input' || code === 'proxy_capacity_unknown' ? 'info' : 'warning',
        },
        concurrency,
      ),
    ).toMatch(expected);
  });
});
