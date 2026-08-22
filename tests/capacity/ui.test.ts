import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CAPACITY_INPUTS, simulateCapacity } from '../../src/core/capacity/index.js';
import { renderCapacityCharts } from '../../src/web/capacity/charts.js';
import {
  FINDING_DOCUMENTATION,
  INPUT_DOCUMENTATION,
  METRIC_DOCUMENTATION,
} from '../../src/web/capacity/documentation.js';
import { renderCapacity } from '../../src/web/capacity/render.js';
import { CapacityStore } from '../../src/web/capacity/state.js';
import { elements, installFakeDom, uninstallFakeDom } from '../web/fake-dom.js';

beforeEach(() => installFakeDom());
afterEach(() => uninstallFakeDom());

describe('capacity UI state', () => {
  it('recomputes immediately when inputs and presets change', () => {
    const store = new CapacityStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.update((inputs) => ({ ...inputs, newSubmissionsPerDay: 1_000 }));
    expect(store.getState().result.traffic.logicalJobsPerDay).toBe(700_000);
    store.applyPlatformPreset('instagram');
    expect(store.getState().inputs.platform).toBe('instagram');
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('adds, removes, reorders, and disables lifecycle stages', () => {
    const store = new CapacityStore();
    store.addStage();
    expect(store.getState().inputs.stages).toHaveLength(4);
    store.moveStage(3, -1);
    expect(store.getState().inputs.stages[2]?.label).toBe('Stage 4');
    store.updateStage(0, { enabled: false });
    expect(store.getState().result.workload.cohorts.profile.lifecycleDays).toBe(24);
    store.removeStage(2);
    expect(store.getState().inputs.stages).toHaveLength(3);
  });
});

describe('capacity result rendering', () => {
  it('renders every result group, provenance, unavailable states, and six SVG charts', () => {
    const store = new CapacityStore({
      ...DEFAULT_CAPACITY_INPUTS,
      requestsPerJob: null,
      bytesPerHttpRequest: null,
    });
    renderCapacity(store.getState());

    for (const id of [
      'planning-summary-results',
      'overview-results',
      'reliability-results',
      'traffic-results',
      'bandwidth-results',
      'concurrency-results',
      'worker-results',
      'proxy-results',
      'cost-results',
      'growth-results',
      'timeline-results',
    ]) {
      expect(elements.get(id)?.innerHTML.length).toBeGreaterThan(0);
      expect(elements.get(id)?.innerHTML).not.toContain('Supporting planning metric');
    }
    expect(elements.get('traffic-results')?.innerHTML).toContain('Unavailable');
    expect(elements.get('traffic-results')?.innerHTML).toContain('info-popover');
    expect(elements.get('traffic-results')?.innerHTML).toContain('one scheduled scrape of one URL');
    expect(elements.get('provenance-results')?.innerHTML).toContain('provenance-badge');
    expect(elements.get('provenance-results')?.innerHTML).toContain('HTTP requests/job');
    for (const id of [
      'workload-chart',
      'traffic-chart',
      'bandwidth-chart',
      'concurrency-chart',
      'proxy-chart',
      'growth-chart',
    ]) {
      expect(elements.get(id)?.innerHTML).toContain('<svg');
      expect(elements.get(id)?.innerHTML).not.toContain('NaN');
    }
  });

  it('adds decision hierarchy and contextual definitions to derived outputs', () => {
    const store = new CapacityStore();
    renderCapacity(store.getState());

    const summary = elements.get('planning-summary-results')?.innerHTML ?? '';
    expect(summary.match(/result-card primary/g)).toHaveLength(6);
    expect(summary).toContain('Recommended proxies');

    const reliability = elements.get('reliability-results')?.innerHTML ?? '';
    expect(reliability).toContain('Eventual job success');
    expect(reliability).toContain('multiply HTTP requests and bandwidth');

    const concurrency = elements.get('concurrency-results')?.innerHTML ?? '';
    expect(concurrency).toContain('95% finish within that latency');

    const proxy = elements.get('proxy-results')?.innerHTML ?? '';
    expect(proxy).toContain('job concurrency, HTTP RPM, or monthly bandwidth');
    expect(proxy).toContain('safety margin');
  });

  it('turns findings into cause, impact, and operator guidance', () => {
    const store = new CapacityStore();
    renderCapacity(store.getState());

    const findings = elements.get('findings-results')?.innerHTML ?? '';
    expect(findings).toContain('<b>Observed:</b>');
    expect(findings).toContain('<b>Why it matters:</b>');
    expect(findings).toContain('<b>Consider:</b>');
    expect(findings).toContain('Configured job slots are below modeled demand');
    expect(findings).not.toContain('concurrency below demand');
  });

  it('keeps chart generation finite for empty and unavailable data', () => {
    const charts = renderCapacityCharts(
      simulateCapacity({
        ...DEFAULT_CAPACITY_INPUTS,
        newSubmissionsPerDay: 0,
        requestsPerJob: null,
        bytesPerHttpRequest: null,
        horizonDays: 1,
      }),
    );
    expect(Object.values(charts)).toHaveLength(6);
    expect(Object.values(charts).join('')).not.toContain('NaN');
  });
});

describe('capacity documentation coverage', () => {
  it('documents every fixed user-editable control', () => {
    const documented = new Set(INPUT_DOCUMENTATION.map((item) => item.id));
    for (const id of [
      'platform-preset',
      'lifecycle-preset',
      'new-submissions',
      'horizon-days',
      'requests-per-job',
      'bytes-per-request',
      'mean-job-latency',
      'p95-job-latency',
      'mean-http-latency',
      'p95-http-latency',
      'attempt-success-rate',
      'permanent-failure-share',
      'max-attempts',
      'retry-initial-delay',
      'retry-max-delay',
      'retry-factor',
      'retry-jitter',
      'job-target-rpm',
      'peak-multiplier',
      'peak-override',
      'workers',
      'worker-concurrency',
      'http-rpm-limit',
      'proxy-pool-size',
      'proxy-concurrency-limit',
      'proxy-rpm-limit',
      'proxy-bandwidth-limit',
      'proxy-probation',
      'proxy-earned',
      'safety-margin',
      'price-per-gb',
      'billing-unit',
      'bill-failed-attempts',
      'price-per-proxy',
      'fixed-pool-price',
      'growth-enabled',
      'growth-rate',
      'growth-months',
    ]) {
      expect(documented.has(id), `${id} should have contextual help`).toBe(true);
    }
  });

  it('covers every finding code and key engineering concept', () => {
    expect(Object.keys(FINDING_DOCUMENTATION)).toHaveLength(19);
    expect(METRIC_DOCUMENTATION.attemptAmplification).toContain('multiply HTTP requests');
    expect(METRIC_DOCUMENTATION.totalCost).toContain('unavailable');
    expect(METRIC_DOCUMENTATION.bindingConstraint).toContain('largest pool');
  });
});
