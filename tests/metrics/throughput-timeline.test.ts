import { describe, expect, it } from 'vitest';

import {
  ThroughputTimeline,
  type TimelineCounts,
} from '../../src/core/metrics/throughput-timeline.js';

function timeline(options: { maxSamples?: number } = {}): {
  timeline: ThroughputTimeline;
  advance: (ms: number) => void;
} {
  let current = 0;
  const instance = new ThroughputTimeline({
    startedAtMs: 0,
    now: () => current,
    ...(options.maxSamples === undefined ? {} : { maxSamples: options.maxSamples }),
  });
  return { timeline: instance, advance: (ms: number) => (current += ms) };
}

function counts(overrides: Partial<TimelineCounts> = {}): TimelineCounts {
  return {
    completed: 0,
    successes: 0,
    failures: 0,
    retries: 0,
    inFlight: 0,
    cycle: 1,
    ...overrides,
  };
}

describe('ThroughputTimeline', () => {
  it('reports the instantaneous rate from the delta, not a cumulative average', () => {
    const { timeline: t, advance } = timeline();

    // 10 requests in the first second = 600 rpm.
    advance(1_000);
    expect(t.record(counts({ completed: 10 }))?.requestsPerMinute).toBeCloseTo(600);

    // Nothing in the next second. A cumulative average would still read 300 rpm;
    // the instantaneous rate must read zero, because that is the dip a soak
    // test exists to find.
    advance(1_000);
    expect(t.record(counts({ completed: 10 }))?.requestsPerMinute).toBe(0);

    // 5 more in the third second = 300 rpm.
    advance(1_000);
    expect(t.record(counts({ completed: 15 }))?.requestsPerMinute).toBeCloseTo(300);
  });

  it('keeps retries out of the throughput figure', () => {
    const { timeline: t, advance } = timeline();

    advance(1_000);
    const sample = t.record(counts({ completed: 5, retries: 40 }));

    expect(sample?.requestsPerMinute).toBeCloseTo(300);
    expect(sample?.retriesPerMinute).toBeCloseTo(2_400);
  });

  it('splits successes and failures into their own rates', () => {
    const { timeline: t, advance } = timeline();

    advance(1_000);
    const sample = t.record(counts({ completed: 10, successes: 7, failures: 3 }));

    expect(sample?.successesPerMinute).toBeCloseTo(420);
    expect(sample?.failuresPerMinute).toBeCloseTo(180);
  });

  it('ignores a second sample taken within the same millisecond', () => {
    const { timeline: t, advance } = timeline();

    advance(1_000);
    expect(t.record(counts({ completed: 1 }))).not.toBeNull();
    // Would otherwise divide by zero and report an infinite rate.
    expect(t.record(counts({ completed: 2 }))).toBeNull();
    expect(t.samples()).toHaveLength(1);
  });

  it('drops the oldest samples past the cap but keeps counting the cursor', () => {
    const { timeline: t, advance } = timeline({ maxSamples: 3 });

    for (let i = 1; i <= 5; i += 1) {
      advance(1_000);
      t.record(counts({ completed: i }));
    }

    expect(t.samples()).toHaveLength(3);
    expect(t.cursor).toBe(5);
    expect(t.samples().map((sample) => sample.completed)).toEqual([3, 4, 5]);
  });

  it('serves only samples newer than a cursor, across eviction', () => {
    const { timeline: t, advance } = timeline({ maxSamples: 3 });

    for (let i = 1; i <= 5; i += 1) {
      advance(1_000);
      t.record(counts({ completed: i }));
    }

    // Cursor 4 means "I have seen the first four"; only the fifth is new.
    expect(t.since(4).map((sample) => sample.completed)).toEqual([5]);
    expect(t.since(5)).toEqual([]);
    // A cursor older than everything retained yields the whole buffer.
    expect(t.since(0)).toHaveLength(3);
  });

  it('tracks the peak instantaneous rate', () => {
    const { timeline: t, advance } = timeline();
    let completed = 0;

    for (const perSecond of [5, 12, 3]) {
      advance(1_000);
      completed += perSecond;
      t.record(counts({ completed }));
    }

    expect(t.peakRequestsPerMinute()).toBeCloseTo(720);
  });

  describe('sustained', () => {
    it('measures the longest contiguous stretch at or above the target', () => {
      const { timeline: t, advance } = timeline();
      let completed = 0;

      // 10/s for 3s (600 rpm), then a slow second, then 10/s for 2s.
      for (const perSecond of [10, 10, 10, 2, 10, 10]) {
        advance(1_000);
        completed += perSecond;
        t.record(counts({ completed }));
      }

      const window = t.sustained(500);
      expect(window.windowMs).toBe(3_000);
      expect(window.fromMs).toBe(0);
      expect(window.toMs).toBe(3_000);
    });

    it('returns a zero window when the target is never met', () => {
      const { timeline: t, advance } = timeline();

      advance(1_000);
      t.record(counts({ completed: 1 }));

      expect(t.sustained(500).windowMs).toBe(0);
    });

    it('treats a zero target as unmeasurable rather than always satisfied', () => {
      const { timeline: t, advance } = timeline();

      advance(1_000);
      t.record(counts({ completed: 10 }));

      expect(t.sustained(0).windowMs).toBe(0);
    });
  });
});
