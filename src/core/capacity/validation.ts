import type { CapacityInputs } from './inputs.js';

export type CapacityValidationCode =
  'not_finite' | 'out_of_range' | 'not_integer' | 'empty' | 'duplicate';

export interface CapacityValidationIssue {
  readonly path: string;
  readonly code: CapacityValidationCode;
  readonly message: string;
}

/** Validates without coercing, mutating, or reading environment state. */
export function validateCapacityInputs(input: CapacityInputs): CapacityValidationIssue[] {
  const issues: CapacityValidationIssue[] = [];
  const number = (
    path: string,
    value: number | null,
    options: { min?: number; max?: number; integer?: boolean; nullable?: boolean } = {},
  ): void => {
    if (value === null) {
      if (options.nullable !== true) add(path, 'empty', 'is required');
      return;
    }
    if (!Number.isFinite(value)) {
      add(path, 'not_finite', 'must be a finite number');
      return;
    }
    if (options.integer === true && !Number.isInteger(value)) {
      add(path, 'not_integer', 'must be a whole number');
    }
    if (options.min !== undefined && value < options.min) {
      add(path, 'out_of_range', `must be at least ${String(options.min)}`);
    }
    if (options.max !== undefined && value > options.max) {
      add(path, 'out_of_range', `must be at most ${String(options.max)}`);
    }
  };
  const add = (path: string, code: CapacityValidationCode, message: string): void => {
    issues.push({ path, code, message: `${path} ${message}` });
  };

  number('newSubmissionsPerDay', input.newSubmissionsPerDay, { min: 0 });
  number('horizonDays', input.horizonDays, { min: 1, integer: true });
  number('requestsPerJob', input.requestsPerJob, { min: Number.MIN_VALUE, nullable: true });
  number('bytesPerHttpRequest', input.bytesPerHttpRequest, {
    min: Number.MIN_VALUE,
    nullable: true,
  });
  number('meanJobLatencyMs', input.meanJobLatencyMs, {
    min: Number.MIN_VALUE,
    nullable: true,
  });
  number('p95JobLatencyMs', input.p95JobLatencyMs, {
    min: Number.MIN_VALUE,
    nullable: true,
  });
  number('meanHttpLatencyMs', input.meanHttpLatencyMs, {
    min: Number.MIN_VALUE,
    nullable: true,
  });
  number('p95HttpLatencyMs', input.p95HttpLatencyMs, {
    min: Number.MIN_VALUE,
    nullable: true,
  });

  const ids = new Set<string>();
  input.stages.forEach((stage, index) => {
    const base = `stages[${String(index)}]`;
    if (stage.id.trim() === '') add(`${base}.id`, 'empty', 'must not be empty');
    if (ids.has(stage.id)) add(`${base}.id`, 'duplicate', 'must be unique');
    ids.add(stage.id);
    if (stage.label.trim() === '') add(`${base}.label`, 'empty', 'must not be empty');
    number(`${base}.durationDays`, stage.durationDays, { min: 1, integer: true });
    number(`${base}.intervalMs`, stage.intervalMs, {
      min: Number.MIN_VALUE,
      nullable: true,
    });
  });

  number('reliability.perAttemptSuccessRate', input.reliability.perAttemptSuccessRate, {
    min: 0,
    max: 1,
  });
  number('reliability.nonRetryableShare', input.reliability.nonRetryableShare, {
    min: 0,
    max: 1,
  });
  number('reliability.maxAttempts', input.reliability.maxAttempts, { min: 1, integer: true });
  number('reliability.retryBackoff.initialDelayMs', input.reliability.retryBackoff.initialDelayMs, {
    min: 0,
  });
  number('reliability.retryBackoff.maxDelayMs', input.reliability.retryBackoff.maxDelayMs, {
    min: 0,
  });
  number('reliability.retryBackoff.backoffFactor', input.reliability.retryBackoff.backoffFactor, {
    min: 1,
  });
  if (input.reliability.retryBackoff.maxDelayMs < input.reliability.retryBackoff.initialDelayMs) {
    add(
      'reliability.retryBackoff.maxDelayMs',
      'out_of_range',
      'must be at least reliability.retryBackoff.initialDelayMs',
    );
  }

  number('capacity.targetJobsPerMinute', input.capacity.targetJobsPerMinute, { min: 0 });
  number('capacity.peakMultiplier', input.capacity.peakMultiplier, { min: 1 });
  number('capacity.peakJobsPerMinuteOverride', input.capacity.peakJobsPerMinuteOverride, {
    min: 0,
    nullable: true,
  });
  number('capacity.workers', input.capacity.workers, { min: 1, integer: true });
  number('capacity.concurrencyPerWorker', input.capacity.concurrencyPerWorker, {
    min: 1,
    integer: true,
  });
  number('capacity.httpRpmPerHost', input.capacity.httpRpmPerHost, {
    min: Number.MIN_VALUE,
    nullable: true,
  });
  number('capacity.proxyPoolSize', input.capacity.proxyPoolSize, { min: 0, integer: true });
  number(
    'capacity.proxyLimits.maxConcurrentPerProxy',
    input.capacity.proxyLimits.maxConcurrentPerProxy,
    { min: Number.MIN_VALUE, nullable: true },
  );
  number(
    'capacity.proxyLimits.maxRequestsPerMinutePerProxy',
    input.capacity.proxyLimits.maxRequestsPerMinutePerProxy,
    { min: Number.MIN_VALUE, nullable: true },
  );
  number(
    'capacity.proxyLimits.maxBytesPerMonthPerProxy',
    input.capacity.proxyLimits.maxBytesPerMonthPerProxy,
    { min: Number.MIN_VALUE, nullable: true },
  );
  number(
    'capacity.proxyLimits.probationConcurrency',
    input.capacity.proxyLimits.probationConcurrency,
    {
      min: 1,
    },
  );
  number(
    'capacity.proxyLimits.earnedConcurrencyPerProxy',
    input.capacity.proxyLimits.earnedConcurrencyPerProxy,
    { min: Number.MIN_VALUE, nullable: true },
  );
  number('capacity.safetyMargin', input.capacity.safetyMargin, { min: 0 });

  number('pricing.pricePerGb', input.pricing.pricePerGb, { min: 0, nullable: true });
  number('pricing.fixedMonthlyPerProxy', input.pricing.fixedMonthlyPerProxy, {
    min: 0,
    nullable: true,
  });
  number('pricing.fixedMonthlyPool', input.pricing.fixedMonthlyPool, {
    min: 0,
    nullable: true,
  });
  number('growth.monthlyGrowthRate', input.growth.monthlyGrowthRate, { min: 0 });
  number('growth.months', input.growth.months, { min: 1, integer: true });

  return issues;
}
