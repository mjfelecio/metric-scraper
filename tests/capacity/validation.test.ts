import { describe, expect, it } from 'vitest';

import { DEFAULT_CAPACITY_INPUTS, validateCapacityInputs } from '../../src/core/capacity/index.js';

describe('capacity input validation', () => {
  it('accepts the shipped measured preset and nullable unknowns', () => {
    expect(validateCapacityInputs(DEFAULT_CAPACITY_INPUTS)).toEqual([]);
  });

  it('returns path-specific issues for invalid rates, durations, limits, and counts', () => {
    const input = {
      ...DEFAULT_CAPACITY_INPUTS,
      horizonDays: 1.5,
      stages: [
        { id: 'same', label: '', durationDays: 0, intervalMs: 0, enabled: true },
        { id: 'same', label: 'Again', durationDays: 1, intervalMs: null, enabled: false },
      ],
      reliability: { ...DEFAULT_CAPACITY_INPUTS.reliability, perAttemptSuccessRate: 1.2 },
      capacity: {
        ...DEFAULT_CAPACITY_INPUTS.capacity,
        workers: 0,
        proxyLimits: {
          ...DEFAULT_CAPACITY_INPUTS.capacity.proxyLimits,
          maxConcurrentPerProxy: 0,
        },
      },
    };
    const paths = validateCapacityInputs(input).map((issue) => issue.path);
    expect(paths).toContain('horizonDays');
    expect(paths).toContain('stages[0].label');
    expect(paths).toContain('stages[0].durationDays');
    expect(paths).toContain('stages[0].intervalMs');
    expect(paths).toContain('stages[1].id');
    expect(paths).toContain('reliability.perAttemptSuccessRate');
    expect(paths).toContain('capacity.workers');
    expect(paths).toContain('capacity.proxyLimits.maxConcurrentPerProxy');
  });
});
