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

function sample(
  tMs: number,
  rpm: number,
  ok: number,
  failed: number,
  retries = 0,
): ThroughputSample {
  return {
    tMs,
    at: new Date(tMs).toISOString(),
    cycle: 1,
    completed: 0,
    successes: 0,
    failures: 0,
    retries: 0,
    inFlight: 0,
    requestsPerMinute: rpm,
    successesPerMinute: ok,
    failuresPerMinute: failed,
    retriesPerMinute: retries,
    bytes: 0,
    bytesPerMinute: 0,
  };
}

function sessionState(timeline: ThroughputSample[]): AppState {
  return {
    ...createInitialState(),
    status: 'running',
    continuous: true,
    targetRpm: 500,
    timeline,
    progress: {
      total: 100,
      processed: 40,
      successful: 35,
      failed: 5,
      inFlight: 4,
      queued: 56,
      elapsedMs: 4_000,
      throughputPerMinute: 480,
    },
    cycle: { current: 2, completed: 1, planned: 5, nextStartsAt: null },
  };
}

describe('throughput chart', () => {
  it('draws an SVG with the target reference line once samples arrive', async () => {
    const { render } = await import('../../src/web/render.js');

    render(
      sessionState([
        sample(0, 0, 0, 0),
        sample(1_000, 480, 450, 30),
        sample(2_000, 520, 500, 20, 60),
      ]),
    );

    const chart = elements.get('throughput-chart');
    expect(chart).toBeDefined();
    expect(chart?.innerHTML).toContain('<svg');
    // The dashed reference line, labelled with the configured target.
    expect(chart?.innerHTML).toContain('target 500/min');
    // Retries are drawn, but labelled so they cannot be read as throughput.
    expect(chart?.innerHTML).toContain('retries/min (not throughput)');
    // No NaN leaking into any coordinate.
    expect(chart?.innerHTML).not.toContain('NaN');
  });

  it('shows a placeholder rather than an empty chart before the second sample', async () => {
    const { render } = await import('../../src/web/render.js');

    render(sessionState([sample(0, 0, 0, 0)]));

    expect(elements.get('throughput-chart')?.innerHTML).toContain('Collecting samples');
  });

  it('hides the panel entirely for a one-shot run', async () => {
    const { render } = await import('../../src/web/render.js');

    render({ ...createInitialState(), status: 'running' });

    expect(elements.get('throughput-panel')?.classList.contains('hidden')).toBe(true);
  });

  it('reports the sustained-at-target window in the stat cards', async () => {
    const { render } = await import('../../src/web/render.js');

    // Three consecutive seconds at or above the 500 target.
    render(
      sessionState([
        sample(0, 0, 0, 0),
        sample(1_000, 600, 600, 0),
        sample(2_000, 600, 600, 0),
        sample(3_000, 600, 600, 0),
      ]),
    );

    const stats = elements.get('progress-stats')?.innerHTML ?? '';
    expect(stats).toContain('Held &gt;= target');
    expect(stats).toContain('3s');
    expect(stats).toContain('Peak');
  });
});

describe('recent results', () => {
  function result(url: string, scrapedAt: string, status: 'ok' | 'error' = 'ok') {
    return {
      url,
      platform: 'tiktok' as const,
      status,
      latencyMs: 412,
      error: status === 'ok' ? null : 'http_error: boom',
      scrapedAt,
      attempts: 1,
      retries: 0,
      proxyId: null,
      httpStatus: status === 'ok' ? 200 : null,
    };
  }

  it('lists a row per result, newest first, for a continuous session', async () => {
    const { render } = await import('../../src/web/render.js');

    // The same URL scraped on three successive cycles: the table must show all
    // three, not collapse them.
    render({
      ...createInitialState(),
      status: 'running',
      continuous: true,
      recentResults: [
        result('https://www.tiktok.com/@a/video/1', '2026-08-19T16:42:18.000Z'),
        result('https://www.tiktok.com/@a/video/1', '2026-08-19T16:41:18.000Z'),
        result('https://www.tiktok.com/@a/video/1', '2026-08-19T16:40:18.000Z', 'error'),
      ],
    });

    const html = elements.get('results')?.innerHTML ?? '';
    expect(html.match(/<tr>/g)).toHaveLength(4); // header row + three results
    // A timestamp per row, so repeated scrapes of one URL are distinguishable.
    expect(html).toContain('2026-08-19T16:42:18.000Z');
    expect(html).toContain('2026-08-19T16:40:18.000Z');
    // A failed cycle is still a result.
    expect(html).toContain('http_error: boom');
    expect(html).toContain('1 / 0');
    expect(html).toContain('200');
    expect(html).toContain('—');
  });

  it('prompts for the first result rather than showing an empty table', async () => {
    const { render } = await import('../../src/web/render.js');

    render({ ...createInitialState(), status: 'running', continuous: true });

    expect(elements.get('results')?.innerHTML).toContain('Waiting for the first result');
  });
});
