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

  /**
   * Minor #2: `state.bandwidth !== null` but `current.bytesPerRequest ===
   * null` — this run (or, in a session, this cycle) measured zero wire
   * requests, while prior runs' history is still sitting in `baseline`. No
   * existing test exercised this branch before; the panel used to hide
   * entirely here, discarding history that has nothing to do with the
   * current run.
   */
  it('shows baseline history but suppresses "this run" and the sparkline when the current run measured nothing', async () => {
    await renderWithState({
      bandwidth: {
        current: {
          requests: 0,
          requestBytes: 0,
          responseBytes: 0,
          totalBytes: 0,
          bytesPerRequest: null,
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
          runs: 3,
          byRequest: 10_400,
          byRun: 9_950,
        },
      },
      // Even with timeline samples present, the sparkline must not draw —
      // this run has nothing measured to plot (R5 still applies here).
      timeline: [timelineSample(0, 500_000), timelineSample(1_000, 600_000)],
    });

    const panel = elements.get('bandwidth-panel');
    // The panel itself stays visible: the sections below draw from
    // cross-run history, not from this run.
    expect(panel?.classList.contains('hidden')).toBe(false);
    expect(panel?.innerHTML).not.toMatch(/this run/i);
    expect(panel?.innerHTML).not.toContain('live bandwidth');
    expect(panel?.innerHTML).not.toContain('<svg');
    // The baseline and "average of all" sections are still fully present.
    expect(panel?.innerHTML).toMatch(/average of all/i);
    expect(panel?.innerHTML).toMatch(/by request/i);
    expect(panel?.innerHTML).toMatch(/by run/i);
    expect(panel?.innerHTML).toContain('9.8 KB');
  });
});

describe('renderBandwidthSparkline (via renderBandwidthPanel)', () => {
  /**
   * Minor #3: both existing render tests short-circuit at
   * `samples.length < 2`, so peak calculation, coordinate mapping and
   * `pathFrom` were wholly untested. This drives a real multi-sample
   * timeline and asserts the drawn path reflects the data, not just that
   * "an svg exists".
   */
  it('draws a path whose coordinates reflect the peak and each sample', async () => {
    // width=260, height=40 (renderBandwidthSparkline's own constants).
    // peak bytesPerMinute across the three samples is 400_000 (the middle one).
    //   t=0:    x=0,   y = 40 - (100_000/400_000)*40 = 30
    //   t=1000: x=130, y = 40 - (400_000/400_000)*40 = 0
    //   t=2000: x=260, y = 40 - (200_000/400_000)*40 = 20
    await renderWithState({
      bandwidth: {
        current: {
          requests: 5,
          requestBytes: 500,
          responseBytes: 4_500,
          totalBytes: 5_000,
          bytesPerRequest: 1_000,
          perProxy: [],
        },
        baseline: { baseline: null, runs: 0, byRequest: null, byRun: null },
      },
      timeline: [
        timelineSample(0, 100_000),
        timelineSample(1_000, 400_000),
        timelineSample(2_000, 200_000),
      ],
    });

    const panel = elements.get('bandwidth-panel');
    expect(panel?.innerHTML).toContain('live bandwidth');
    expect(panel?.innerHTML).toContain('<path d="M0 30 L130 0 L260 20"');
  });

  it('draws nothing when every sample has zero bandwidth (peak <= 0)', async () => {
    await renderWithState({
      bandwidth: {
        current: {
          requests: 5,
          requestBytes: 500,
          responseBytes: 4_500,
          totalBytes: 5_000,
          bytesPerRequest: 1_000,
          perProxy: [],
        },
        baseline: { baseline: null, runs: 0, byRequest: null, byRun: null },
      },
      timeline: [timelineSample(0, 0), timelineSample(1_000, 0)],
    });

    const panel = elements.get('bandwidth-panel');
    expect(panel?.innerHTML).not.toContain('live bandwidth');
  });
});
