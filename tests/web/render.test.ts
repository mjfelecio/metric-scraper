import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { type ThroughputSample } from '../../src/core/metrics/throughput-timeline.js';
import { createInitialState, type AppState } from '../../src/web/state.js';

import { elements, installFakeDom, uninstallFakeDom } from './fake-dom.js';

beforeEach(() => {
  installFakeDom();
});

afterEach(() => {
  uninstallFakeDom();
});

function timelineSample(tMs: number, bytesPerMinute: number): ThroughputSample {
  return {
    tMs,
    at: new Date(tMs).toISOString(),
    cycle: 1,
    completed: 0,
    successes: 0,
    failures: 0,
    retries: 0,
    inFlight: 0,
    requestsPerMinute: 0,
    successesPerMinute: 0,
    failuresPerMinute: 0,
    retriesPerMinute: 0,
    bytes: 0,
    bytesPerMinute,
  };
}

async function renderWithState(patch: Partial<AppState>): Promise<void> {
  const { render } = await import('../../src/web/render.js');
  render({ ...createInitialState(), ...patch });
}

describe('renderBandwidthPanel', () => {
  it('stays hidden when nothing has been measured', async () => {
    await renderWithState({ bandwidth: null });
    expect(elements.get('bandwidth-panel')?.classList.contains('hidden')).toBe(true);
  });

  it('shows this run, the baseline and both averages', async () => {
    await renderWithState({
      bandwidth: {
        current: {
          requests: 142,
          requestBytes: 40_000,
          responseBytes: 1_393_600,
          totalBytes: 1_433_600,
          bytesPerRequest: 10_096,
          perProxy: [],
        },
        baseline: {
          baseline: {
            runId: 'prev',
            finishedAt: '2026-08-19T00:00:00Z',
            requests: 100,
            totalBytes: 980_000,
            avgBytesPerRequest: 9_800,
          },
          runs: 2,
          byRequest: 10_400,
          byRun: 30_000,
        },
      },
    });

    const panel = elements.get('bandwidth-panel');
    expect(panel?.classList.contains('hidden')).toBe(false);
    expect(panel?.innerHTML).toContain('142');
    // Both averages appear, because they answer different questions.
    expect(panel?.innerHTML).toMatch(/by request/i);
    expect(panel?.innerHTML).toMatch(/by run/i);
  });

  it('R5: an unmeasured run draws no bandwidth series, even with nonzero timeline bytes', async () => {
    // Simulates METRICS_BANDWIDTH off: ThroughputSample.bytes/bytesPerMinute
    // are fed `?? 0` by the aggregator-less path. Even if a sample somehow
    // carried a nonzero figure, `bandwidth: null` must still suppress every
    // bandwidth series — a displayed line here would read as "measured", which
    // would be false.
    await renderWithState({
      bandwidth: null,
      timeline: [timelineSample(0, 500_000), timelineSample(1_000, 600_000)],
    });

    const panel = elements.get('bandwidth-panel');
    expect(panel?.classList.contains('hidden')).toBe(true);
    expect(panel?.innerHTML).toBe('');
    // No stray bandwidth svg drawn into any other panel either.
    expect(elements.get('throughput-chart')?.innerHTML ?? '').not.toContain('bandwidth');
  });
});
