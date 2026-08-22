import { describe, expect, it } from 'vitest';

import { DEFAULT_CAPACITY_INPUTS, evaluateReliability } from '../../src/core/capacity/index.js';

describe('capacity reliability', () => {
  it('keeps permanent failures out of retry amplification', () => {
    const model = evaluateReliability(DEFAULT_CAPACITY_INPUTS.reliability);
    expect(model.permanentFailureRate).toBeCloseTo(0.050625, 8);
    expect(model.retryRate * 1_600).toBeCloseTo(15.04, 1);
    expect(model.jobSuccessRate).toBeCloseTo(0.949374, 5);
    expect(model.attemptAmplification).toBeCloseTo(1.00949, 5);
  });

  it('models exhaustion at the configured attempt limit', () => {
    const model = evaluateReliability({
      ...DEFAULT_CAPACITY_INPUTS.reliability,
      perAttemptSuccessRate: 0,
      nonRetryableShare: 0.25,
      maxAttempts: 4,
    });
    expect(model.exhaustedRate).toBe(0.75);
    expect(model.attemptAmplification).toBe(3.25);
    expect(model.maxRetries).toBe(3);
  });
});
