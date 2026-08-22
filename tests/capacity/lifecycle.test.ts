import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CAPACITY_INPUTS,
  pollInstantsByDay,
  simulateCohorts,
} from '../../src/core/capacity/index.js';

describe('capacity lifecycle', () => {
  it('counts exact start-to-start instants for intervals that do not divide a day', () => {
    expect(pollInstantsByDay(7, 7 * 60_000)).toEqual([206, 206, 206, 205, 206, 206, 205]);
    expect(pollInstantsByDay(1, 30 * 86_400_000)).toEqual([1]);
  });

  it('collapses disabled stages but retains enabled dormant stages', () => {
    const result = simulateCohorts({
      newSubmissionsPerDay: 10,
      horizonDays: 3,
      stages: [
        { id: 'off', label: 'Off', durationDays: 20, intervalMs: 1_000, enabled: false },
        { id: 'dormant', label: 'Dormant', durationDays: 2, intervalMs: null, enabled: true },
      ],
    });
    expect(result.profile.lifecycleDays).toBe(2);
    expect(result.profile.pollsPerSubmissionTotal).toBe(0);
    expect(result.days[1]?.activeSubmissions).toBe(20);
  });

  it('reports the polling and active plateaus independently', () => {
    const day29 = simulateCohorts({
      newSubmissionsPerDay: 500,
      horizonDays: 29,
      stages: DEFAULT_CAPACITY_INPUTS.stages,
    });
    expect(day29.jobsPlateauDayIndex).toBe(28);
    expect(day29.pollingSteadyState?.scrapeJobs).toBe(358_000);
    expect(day29.activePlateauDayIndex).toBeNull();
    expect(day29.steadyState).toBeNull();

    const day30 = simulateCohorts({
      newSubmissionsPerDay: 500,
      horizonDays: 30,
      stages: DEFAULT_CAPACITY_INPUTS.stages,
    });
    expect(day30.activePlateauDayIndex).toBe(29);
    expect(day30.steadyState?.activeSubmissions).toBe(15_000);
  });
});
