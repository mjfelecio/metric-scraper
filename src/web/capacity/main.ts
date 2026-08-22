import type { CapacityInputs } from '../../core/capacity/index.js';

import { renderCapacity } from './render.js';
import { CapacityStore, type LifecyclePreset } from './state.js';
import './styles.css';

const store = new CapacityStore();
store.subscribe(renderCapacity);

document.addEventListener('input', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLSelectElement)) return;
  if (target.closest('[data-stage-index]') !== null) return;
  updateControl(target);
});

document.addEventListener('change', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLSelectElement)) return;
  const stageRow = target.closest<HTMLElement>('[data-stage-index]');
  if (stageRow !== null) {
    updateStageControl(target, stageRow);
    return;
  }
  updateControl(target);
});

document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const inputHelp = target.closest<HTMLElement>('.input-info-tip');
  if (inputHelp !== null) {
    event.preventDefault();
    inputHelp.focus();
    return;
  }
  if (target.closest('#add-stage') !== null) {
    store.addStage();
    return;
  }
  const button = target.closest<HTMLButtonElement>('[data-stage-action]');
  const row = button?.closest<HTMLElement>('[data-stage-index]');
  if (button === null || button === undefined || row === null || row === undefined) return;
  const index = Number(row.dataset['stageIndex']);
  if (!Number.isInteger(index)) return;
  const action = button.dataset['stageAction'];
  if (action === 'remove') store.removeStage(index);
  if (action === 'up') store.moveStage(index, -1);
  if (action === 'down') store.moveStage(index, 1);
});

function updateControl(target: HTMLInputElement | HTMLSelectElement): void {
  if (target.id === 'platform-preset') {
    store.applyPlatformPreset(target.value);
    return;
  }
  if (target.id === 'lifecycle-preset') {
    if (isLifecyclePreset(target.value)) store.applyLifecyclePreset(target.value);
    return;
  }
  if (target.id === 'retry-jitter' && target instanceof HTMLInputElement) {
    store.update((inputs) => ({
      ...inputs,
      reliability: {
        ...inputs.reliability,
        retryBackoff: { ...inputs.reliability.retryBackoff, jitter: target.checked },
      },
    }));
    return;
  }
  if (target.id === 'bill-failed-attempts' && target instanceof HTMLInputElement) {
    store.update((inputs) => ({
      ...inputs,
      pricing: { ...inputs.pricing, billsFailedAttempts: target.checked },
    }));
    return;
  }
  if (target.id === 'growth-enabled' && target instanceof HTMLInputElement) {
    store.update((inputs) => ({
      ...inputs,
      growth: { ...inputs.growth, enabled: target.checked },
    }));
    return;
  }
  if (target.id === 'billing-unit' && (target.value === 'GB' || target.value === 'GiB')) {
    store.update((inputs) => ({
      ...inputs,
      pricing: { ...inputs.pricing, billingUnit: target.value as 'GB' | 'GiB' },
    }));
    return;
  }

  const nullable = NULLABLE_CONTROLS.has(target.id);
  const number = parseNumeric(target.value, nullable);
  store.update((inputs) => updateNumericInput(inputs, target.id, number));
}

function updateStageControl(target: HTMLInputElement | HTMLSelectElement, row: HTMLElement): void {
  const index = Number(row.dataset['stageIndex']);
  if (!Number.isInteger(index)) return;
  const field = target.dataset['stageField'];
  if (field === 'enabled' && target instanceof HTMLInputElement) {
    store.updateStage(index, { enabled: target.checked });
  } else if (field === 'label') {
    store.updateStage(index, { label: target.value });
  } else if (field === 'durationDays') {
    store.updateStage(index, { durationDays: Number(target.value) });
  } else if (field === 'intervalMinutes') {
    store.updateStage(index, {
      intervalMs: target.value.trim() === '' ? null : Number(target.value) * 60_000,
    });
  }
}

const NULLABLE_CONTROLS = new Set([
  'requests-per-job',
  'bytes-per-request',
  'mean-job-latency',
  'p95-job-latency',
  'mean-http-latency',
  'p95-http-latency',
  'peak-override',
  'http-rpm-limit',
  'proxy-concurrency-limit',
  'proxy-rpm-limit',
  'proxy-bandwidth-limit',
  'proxy-earned',
  'price-per-gb',
  'price-per-proxy',
  'fixed-pool-price',
]);

function parseNumeric(value: string, nullable: boolean): number | null {
  if (nullable && value.trim() === '') return null;
  return Number(value);
}

function updateNumericInput(
  inputs: CapacityInputs,
  id: string,
  value: number | null,
): CapacityInputs {
  const number = value ?? 0;
  switch (id) {
    case 'new-submissions':
      return { ...inputs, newSubmissionsPerDay: number };
    case 'horizon-days':
      return { ...inputs, horizonDays: number };
    case 'requests-per-job':
      return { ...inputs, requestsPerJob: value };
    case 'bytes-per-request':
      return { ...inputs, bytesPerHttpRequest: value };
    case 'mean-job-latency':
      return { ...inputs, meanJobLatencyMs: value };
    case 'p95-job-latency':
      return { ...inputs, p95JobLatencyMs: value };
    case 'mean-http-latency':
      return { ...inputs, meanHttpLatencyMs: value };
    case 'p95-http-latency':
      return { ...inputs, p95HttpLatencyMs: value };
    case 'attempt-success-rate':
      return { ...inputs, reliability: { ...inputs.reliability, perAttemptSuccessRate: number } };
    case 'permanent-failure-share':
      return { ...inputs, reliability: { ...inputs.reliability, nonRetryableShare: number } };
    case 'max-attempts':
      return { ...inputs, reliability: { ...inputs.reliability, maxAttempts: number } };
    case 'retry-initial-delay':
      return updateBackoff(inputs, { initialDelayMs: number });
    case 'retry-max-delay':
      return updateBackoff(inputs, { maxDelayMs: number });
    case 'retry-factor':
      return updateBackoff(inputs, { backoffFactor: number });
    case 'job-target-rpm':
      return updateCapacity(inputs, { targetJobsPerMinute: number });
    case 'peak-multiplier':
      return updateCapacity(inputs, { peakMultiplier: number });
    case 'peak-override':
      return updateCapacity(inputs, { peakJobsPerMinuteOverride: value });
    case 'workers':
      return updateCapacity(inputs, { workers: number });
    case 'worker-concurrency':
      return updateCapacity(inputs, { concurrencyPerWorker: number });
    case 'http-rpm-limit':
      return updateCapacity(inputs, { httpRpmPerHost: value });
    case 'proxy-pool-size':
      return updateCapacity(inputs, { proxyPoolSize: number });
    case 'proxy-concurrency-limit':
      return updateProxyLimits(inputs, { maxConcurrentPerProxy: value });
    case 'proxy-rpm-limit':
      return updateProxyLimits(inputs, { maxRequestsPerMinutePerProxy: value });
    case 'proxy-bandwidth-limit':
      return updateProxyLimits(inputs, { maxBytesPerMonthPerProxy: value });
    case 'proxy-probation':
      return updateProxyLimits(inputs, { probationConcurrency: number });
    case 'proxy-earned':
      return updateProxyLimits(inputs, { earnedConcurrencyPerProxy: value });
    case 'safety-margin':
      return updateCapacity(inputs, { safetyMargin: number });
    case 'price-per-gb':
      return { ...inputs, pricing: { ...inputs.pricing, pricePerGb: value } };
    case 'price-per-proxy':
      return { ...inputs, pricing: { ...inputs.pricing, fixedMonthlyPerProxy: value } };
    case 'fixed-pool-price':
      return { ...inputs, pricing: { ...inputs.pricing, fixedMonthlyPool: value } };
    case 'growth-rate':
      return { ...inputs, growth: { ...inputs.growth, monthlyGrowthRate: number } };
    case 'growth-months':
      return { ...inputs, growth: { ...inputs.growth, months: number } };
    default:
      return inputs;
  }
}

function updateBackoff(
  inputs: CapacityInputs,
  patch: Partial<CapacityInputs['reliability']['retryBackoff']>,
): CapacityInputs {
  return {
    ...inputs,
    reliability: {
      ...inputs.reliability,
      retryBackoff: { ...inputs.reliability.retryBackoff, ...patch },
    },
  };
}

function updateCapacity(
  inputs: CapacityInputs,
  patch: Partial<CapacityInputs['capacity']>,
): CapacityInputs {
  return { ...inputs, capacity: { ...inputs.capacity, ...patch } };
}

function updateProxyLimits(
  inputs: CapacityInputs,
  patch: Partial<CapacityInputs['capacity']['proxyLimits']>,
): CapacityInputs {
  return {
    ...inputs,
    capacity: {
      ...inputs.capacity,
      proxyLimits: { ...inputs.capacity.proxyLimits, ...patch },
    },
  };
}

function isLifecyclePreset(value: string): value is LifecyclePreset {
  return value === 'tapered' || value === 'flat' || value === 'custom';
}
