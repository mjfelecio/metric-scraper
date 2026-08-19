import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { type MetricPointDto } from '../../src/app/types.js';
import { createInitialState, type AppState } from '../../src/web/state.js';

import {
  elements,
  installFakeDom,
  makeElement,
  uninstallFakeDom,
  type FakeElement,
} from './fake-dom.js';

let tabs: FakeElement[] = [];

beforeEach(() => {
  tabs = ['views', 'likes', 'comments', 'shares'].map((metric) => {
    const node = makeElement(`tab-${metric}`);
    node.dataset['metric'] = metric;
    return node;
  });
  installFakeDom({ '.metric-tab-btn': tabs });
});

afterEach(() => {
  uninstallFakeDom();
});

function point(
  cycle: number,
  metrics: Partial<Pick<MetricPointDto, 'views' | 'likes' | 'comments' | 'shares'>>,
  status: MetricPointDto['status'] = 'ok',
): MetricPointDto {
  return {
    cycle,
    at: new Date(Date.UTC(2026, 7, 19, 16, 40 + cycle, 0)).toISOString(),
    status,
    views: null,
    likes: null,
    comments: null,
    shares: null,
    ...metrics,
  };
}

const SERIES = [
  point(1, { views: 144_827, likes: 8_324, comments: 212, shares: 897 }),
  point(2, { views: 148_500, likes: 8_330, comments: 213, shares: 899 }),
  point(3, { views: 153_247, likes: 8_341, comments: 214, shares: 901 }),
];

/** Continuous mode with a single accepted URL — the only case that renders. */
function monitorState(overrides: Partial<AppState> = {}): AppState {
  return {
    ...createInitialState(),
    status: 'running',
    continuous: true,
    input: { candidates: 1, accepted: 1, rejected: 0, issues: [] },
    metricSeries: SERIES,
    ...overrides,
  };
}

async function renderWith(state: AppState): Promise<void> {
  const { render } = await import('../../src/web/render.js');
  render(state);
}

describe('metric time series — visibility', () => {
  it('shows for continuous mode with exactly one URL', async () => {
    await renderWith(monitorState());

    expect(elements.get('metric-series-panel')?.classList.contains('hidden')).toBe(false);
    expect(elements.get('metric-series-chart')?.innerHTML).toContain('<svg');
  });

  it('hides for continuous mode with multiple URLs', async () => {
    await renderWith(
      monitorState({ input: { candidates: 3, accepted: 3, rejected: 0, issues: [] } }),
    );

    expect(elements.get('metric-series-panel')?.classList.contains('hidden')).toBe(true);
  });

  it('hides for a normal one-shot run', async () => {
    await renderWith(monitorState({ continuous: false }));

    expect(elements.get('metric-series-panel')?.classList.contains('hidden')).toBe(true);
  });

  it('hides before any input has been parsed', async () => {
    await renderWith(monitorState({ input: null }));

    expect(elements.get('metric-series-panel')?.classList.contains('hidden')).toBe(true);
  });

  it('shows a placeholder before the first cycle completes', async () => {
    await renderWith(monitorState({ metricSeries: [] }));

    expect(elements.get('metric-series-panel')?.classList.contains('hidden')).toBe(false);
    expect(elements.get('metric-series-chart')?.innerHTML).toContain('Waiting for the first cycle');
  });
});

describe('metric time series — chart', () => {
  it('draws one marker per completed cycle', async () => {
    await renderWith(monitorState());

    const html = elements.get('metric-series-chart')?.innerHTML ?? '';
    expect(html.match(/class="metric-point"/g)).toHaveLength(3);
    expect(html).not.toContain('NaN');
  });

  it('abbreviates on the axis but exposes the exact integer in the tooltip', async () => {
    await renderWith(monitorState());

    const html = elements.get('metric-series-chart')?.innerHTML ?? '';
    // Axis labels are abbreviated...
    expect(html).toContain('>150K</text>');
    expect(html).not.toContain('>150,000<');
    // ...while the tooltip carries the underlying value, unrounded.
    expect(html).toContain('153,247');
  });

  it('zooms the axis to the data when the movement is small next to the total', async () => {
    await renderWith(monitorState());

    // 144,827 -> 153,247 on a zero-based axis would be a flat line. The window
    // is quantized to a round step so it holds still as cycles arrive.
    const html = elements.get('metric-series-chart')?.innerHTML ?? '';
    expect(html).toContain('>140K</text>');
    expect(html).toContain('>160K</text>');
  });

  it('shows the change from the previous cycle, and none for the first', async () => {
    await renderWith(monitorState());

    const html = elements.get('metric-series-chart')?.innerHTML ?? '';
    expect(html).toContain('+3,673'); // cycle 2: 148,500 - 144,827
    expect(html).toContain('+4,747'); // cycle 3: 153,247 - 148,500
    // Only two deltas exist across three points.
    expect(html.match(/&gt;\+[\d,]+</g) ?? html.match(/\+[\d,]+</g)).toHaveLength(2);
  });

  it('labels every point with its cycle number', async () => {
    await renderWith(monitorState());

    const html = elements.get('metric-series-chart')?.innerHTML ?? '';
    expect(html).toContain('Cycle 1');
    expect(html).toContain('Cycle 2');
    expect(html).toContain('Cycle 3');
  });

  it('plots the selected metric only', async () => {
    await renderWith(monitorState({ metric: 'comments' }));

    const html = elements.get('metric-series-chart')?.innerHTML ?? '';
    expect(html).toContain('Comments');
    expect(html).toContain('214');
    // The views figures belong to a different series and must not be drawn.
    expect(html).not.toContain('153,247');
  });

  it('marks the active metric tab', async () => {
    await renderWith(monitorState({ metric: 'likes' }));

    expect(tabs.map((tab) => tab.dataset['active'])).toEqual(['false', 'true', 'false', 'false']);
  });

  it('thins markers but never the line once a session runs long', async () => {
    const long = Array.from({ length: 500 }, (_, index) =>
      point(index + 1, { views: 100_000 + index * 900 }),
    );
    await renderWith(monitorState({ metricSeries: long }));

    const html = elements.get('metric-series-chart')?.innerHTML ?? '';
    const markers = html.match(/class="metric-point"/g) ?? [];
    // Bounded regardless of session length, so a long run cannot grow the
    // markup without limit — but the newest cycle is always among them.
    expect(markers.length).toBeLessThanOrEqual(96);
    expect(html).toContain('Cycle 500');
    expect(html).toContain('<path');
  });

  it('does not redraw when nothing about the series changed', async () => {
    const { render } = await import('../../src/web/render.js');
    const state = monitorState();

    render(state);
    const drawn = elements.get('metric-series-chart')?.innerHTML ?? '';
    expect(drawn).toContain('<svg');

    // A poll tick that brought no new cycle must not rebuild the markup.
    const chart = elements.get('metric-series-chart');
    if (chart !== undefined) chart.innerHTML = 'UNTOUCHED';
    render(state);
    expect(elements.get('metric-series-chart')?.innerHTML).toBe('UNTOUCHED');

    // A new cycle does redraw.
    render({ ...state, metricSeries: [...SERIES, point(4, { views: 160_000 })] });
    expect(elements.get('metric-series-chart')?.innerHTML).toContain('Cycle 4');
  });

  it('breaks the line at a cycle that reported nothing', async () => {
    await renderWith(
      monitorState({
        metricSeries: [
          point(1, { views: 1_000 }),
          point(2, {}, 'rate_limited'),
          point(3, { views: 1_042 }),
        ],
      }),
    );

    const html = elements.get('metric-series-chart')?.innerHTML ?? '';
    expect(html).toContain('no value (rate_limited)');
    // The gap cycle still gets a hoverable marker, so it is three in total.
    expect(html.match(/class="metric-point"/g)).toHaveLength(3);
    // The delta on cycle 3 is measured against cycle 1, not against the gap.
    expect(html).toContain('+42');
    expect(html).not.toContain('NaN');
  });
});
