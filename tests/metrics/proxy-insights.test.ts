import { describe, expect, it } from 'vitest';

import { summarizeFailureConcentration } from '../../src/core/metrics/proxy-insights.js';

function proxy(
  label: string,
  failures: number,
): { proxy_id: string; label: string; failures: number } {
  return { proxy_id: `http://${label}.example:8000`, label, failures };
}

describe('summarizeFailureConcentration', () => {
  it('calls it concentrated when a few proxies carry most of the failures', () => {
    const result = summarizeFailureConcentration([
      proxy('p1', 1),
      proxy('p2', 0),
      proxy('p3', 14),
      proxy('p4', 1),
      proxy('p5', 12),
    ]);

    expect(result.concentrated).toBe(true);
    expect(result.worst.map((entry) => entry.label)).toEqual(['p3', 'p5']);
    expect(result.topShare).toBeCloseTo(26 / 28);
    expect(result.totalFailures).toBe(28);
  });

  it('does not call it concentrated when the whole pool is failing evenly', () => {
    // This is the shape that says "not the proxies" — the distinction the view
    // exists to make.
    const result = summarizeFailureConcentration([
      proxy('p1', 10),
      proxy('p2', 9),
      proxy('p3', 11),
      proxy('p4', 10),
      proxy('p5', 10),
    ]);

    expect(result.concentrated).toBe(false);
  });

  it('treats a handful of failures as noise rather than a finding', () => {
    const result = summarizeFailureConcentration([proxy('p1', 2), proxy('p2', 0), proxy('p3', 0)]);

    expect(result.totalFailures).toBe(2);
    expect(result.concentrated).toBe(false);
  });

  it('does not mistake an even split across a small pool for concentration', () => {
    // Three proxies failing equally puts 67% in the top two by arithmetic.
    const result = summarizeFailureConcentration([proxy('p1', 2), proxy('p2', 2), proxy('p3', 2)]);

    expect(result.topShare).toBeCloseTo(2 / 3);
    expect(result.concentrated).toBe(false);
  });

  it('still flags a small pool where the healthy proxies carry nothing', () => {
    const result = summarizeFailureConcentration([proxy('p1', 8), proxy('p2', 7), proxy('p3', 0)]);

    expect(result.concentrated).toBe(true);
  });

  it('says nothing about a pool too small for the question', () => {
    const result = summarizeFailureConcentration([proxy('p1', 30), proxy('p2', 1)]);

    // With two proxies, "the top two carry it all" is arithmetic.
    expect(result.concentrated).toBe(false);
  });

  it('is empty when nothing failed', () => {
    const result = summarizeFailureConcentration([proxy('p1', 0), proxy('p2', 0)]);

    expect(result).toEqual({ totalFailures: 0, worst: [], topShare: 0, concentrated: false });
  });
});
