import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { type ThroughputSample } from '../../src/core/metrics/throughput-timeline.js';
import { createInitialState, type AppState } from '../../src/web/state.js';

/**
 * Minimal DOM stand-in.
 *
 * The dashboard renders with `innerHTML` against a fixed set of element ids
 * (there is no framework), so a map of fake nodes is enough to drive a real
 * render and inspect what comes out.
 */
interface FakeElement {
  id: string;
  innerHTML: string;
  textContent: string;
  className: string;
  checked: boolean;
  disabled: boolean;
  style: Record<string, string>;
  dataset: Record<string, string>;
  classList: {
    add: (name: string) => void;
    remove: (name: string) => void;
    toggle: (name: string, force?: boolean) => void;
    contains: (name: string) => boolean;
  };
}

const elements = new Map<string, FakeElement>();

function makeElement(id: string): FakeElement {
  const classes = new Set<string>();
  return {
    id,
    innerHTML: '',
    textContent: '',
    className: '',
    checked: false,
    disabled: false,
    style: {},
    dataset: {},
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      toggle: (name, force) => {
        const on = force ?? !classes.has(name);
        if (on) classes.add(name);
        else classes.delete(name);
      },
      contains: (name) => classes.has(name),
    },
  };
}

/**
 * `instanceof` checks in `renderControls` need these to exist. Nothing is ever
 * an instance of them, so those branches simply skip — the chart is what these
 * tests are about.
 */
const DOM_GLOBALS = [
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'HTMLSelectElement',
  'HTMLButtonElement',
] as const;

beforeEach(() => {
  elements.clear();
  for (const name of DOM_GLOBALS) {
    (globalThis as unknown as Record<string, unknown>)[name] = class {};
  }
  (globalThis as unknown as { document: unknown }).document = {
    getElementById: (id: string): FakeElement => {
      let node = elements.get(id);
      if (node === undefined) {
        node = makeElement(id);
        elements.set(id, node);
      }
      return node;
    },
    querySelectorAll: (): FakeElement[] => [],
  };
});

afterEach(() => {
  delete (globalThis as unknown as { document?: unknown }).document;
  for (const name of DOM_GLOBALS) {
    delete (globalThis as unknown as Record<string, unknown>)[name];
  }
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
