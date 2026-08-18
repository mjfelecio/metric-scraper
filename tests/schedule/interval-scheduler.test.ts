import { describe, expect, it } from 'vitest';

import {
  scheduleCycles,
  type IntervalSchedulerOptions,
  type ScheduleOutcome,
} from '../../src/core/schedule/interval-scheduler.js';

/** Fake clock: `sleep` advances time instantly, so no test waits on real time. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[] } {
  let current = 0;
  const slept: number[] = [];
  return {
    now: () => current,
    sleep: (ms: number) => {
      slept.push(ms);
      current += ms;
      return Promise.resolve();
    },
    slept,
  };
}

async function collect(
  options: IntervalSchedulerOptions,
  outcome: ScheduleOutcome,
  onCycle?: (starts: number[]) => void,
): Promise<number[]> {
  const starts: number[] = [];
  for await (const context of scheduleCycles(options, outcome)) {
    starts.push(context.startedAt);
    onCycle?.(starts);
  }
  return starts;
}

describe('scheduleCycles', () => {
  it('spaces cycle starts by the interval, measured start to start', async () => {
    const clock = fakeClock();
    const outcome: ScheduleOutcome = { stopReason: 'completed', cyclesStarted: 0 };

    const starts = await collect(
      { intervalMs: 900_000, maxCycles: 3, now: clock.now, sleep: clock.sleep },
      outcome,
    );

    expect(starts).toEqual([0, 900_000, 1_800_000]);
    expect(outcome.stopReason).toBe('max_cycles');
    expect(outcome.cyclesStarted).toBe(3);
  });

  it('runs back to back when the interval is zero', async () => {
    const clock = fakeClock();
    const outcome: ScheduleOutcome = { stopReason: 'completed', cyclesStarted: 0 };

    const starts = await collect(
      { intervalMs: 0, maxCycles: 4, now: clock.now, sleep: clock.sleep },
      outcome,
    );

    expect(starts).toEqual([0, 0, 0, 0]);
    expect(clock.slept).toHaveLength(0);
  });

  it('does not drift: a slow cycle is absorbed, not added to the next interval', async () => {
    let current = 0;
    const outcome: ScheduleOutcome = { stopReason: 'completed', cyclesStarted: 0 };
    const starts: number[] = [];

    for await (const context of scheduleCycles(
      {
        intervalMs: 1_000,
        maxCycles: 4,
        now: () => current,
        sleep: (ms) => {
          current += ms;
          return Promise.resolve();
        },
      },
      outcome,
    )) {
      starts.push(context.startedAt);
      // The second cycle takes 400ms; every start must stay on the 1s grid.
      current += context.cycle === 2 ? 400 : 10;
    }

    expect(starts).toEqual([0, 1_000, 2_000, 3_000]);
  });

  it('starts the next cycle immediately when one overruns, and reports the lag', async () => {
    let current = 0;
    const outcome: ScheduleOutcome = { stopReason: 'completed', cyclesStarted: 0 };
    const observed: Array<{ cycle: number; lagMs: number }> = [];

    for await (const context of scheduleCycles(
      {
        intervalMs: 1_000,
        maxCycles: 3,
        now: () => current,
        sleep: (ms) => {
          current += ms;
          return Promise.resolve();
        },
      },
      outcome,
    )) {
      observed.push({ cycle: context.cycle, lagMs: context.lagMs });
      // Cycle 1 runs for 2.5s, blowing through two whole interval windows.
      current += context.cycle === 1 ? 2_500 : 10;
    }

    expect(observed[0]).toEqual({ cycle: 1, lagMs: 0 });
    // Cycle 2 was due at 1000 but could not start until 2500.
    expect(observed[1]).toEqual({ cycle: 2, lagMs: 1_500 });
    expect(observed[2]).toEqual({ cycle: 3, lagMs: 510 });
  });

  it('stops starting cycles once the duration is spent', async () => {
    const clock = fakeClock();
    const outcome: ScheduleOutcome = { stopReason: 'completed', cyclesStarted: 0 };

    const starts = await collect(
      { intervalMs: 1_000, durationMs: 3_000, now: clock.now, sleep: clock.sleep },
      outcome,
    );

    // Due at 0, 1000, 2000; the cycle due at 3000 is past the deadline.
    expect(starts).toEqual([0, 1_000, 2_000]);
    expect(outcome.stopReason).toBe('duration');
  });

  it('does not idle past its own deadline when the interval exceeds the duration', async () => {
    const clock = fakeClock();
    const outcome: ScheduleOutcome = { stopReason: 'completed', cyclesStarted: 0 };

    const starts = await collect(
      { intervalMs: 900_000, durationMs: 600_000, now: clock.now, sleep: clock.sleep },
      outcome,
    );

    expect(starts).toEqual([0]);
    expect(outcome.stopReason).toBe('duration');
    // The decisive assertion: it never slept the 15 minutes it would have
    // waited before noticing the 10-minute deadline had passed.
    expect(clock.slept).toHaveLength(0);
  });

  it('stops when the signal aborts mid-wait', async () => {
    const controller = new AbortController();
    let current = 0;
    const outcome: ScheduleOutcome = { stopReason: 'completed', cyclesStarted: 0 };
    const starts: number[] = [];

    for await (const context of scheduleCycles(
      {
        intervalMs: 1_000,
        signal: controller.signal,
        now: () => current,
        sleep: (ms) => {
          current += ms;
          return Promise.resolve();
        },
      },
      outcome,
    )) {
      starts.push(context.startedAt);
      if (context.cycle === 2) controller.abort();
    }

    expect(starts).toEqual([0, 1_000]);
    expect(outcome.stopReason).toBe('cancelled');
  });

  it('yields nothing when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome: ScheduleOutcome = { stopReason: 'completed', cyclesStarted: 0 };

    const starts = await collect({ intervalMs: 0, signal: controller.signal }, outcome);

    expect(starts).toEqual([]);
    expect(outcome.stopReason).toBe('cancelled');
  });
});
