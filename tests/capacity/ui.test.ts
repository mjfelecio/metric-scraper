import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CAPACITY_INPUTS, simulateCapacity } from '../../src/core/capacity/index.js';
import { renderCapacityCharts } from '../../src/web/capacity/charts.js';
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
    }
    expect(elements.get('traffic-results')?.innerHTML).toContain('Unavailable');
    expect(elements.get('provenance-results')?.innerHTML).toContain('provenance-badge');
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
