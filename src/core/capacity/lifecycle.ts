import { info, warning, type CapacityFinding } from './findings.js';
import { MINUTES_PER_DAY, MS_PER_DAY, type PollingStage } from './inputs.js';

/**
 * The cohort simulation: what a steady intake of submissions costs per day.
 *
 * Deliberately *not* `submissions_per_day x some_average_poll_count`. Every
 * submission moves through the polling lifecycle on its own clock, so the load
 * on any given day is the sum over every cohort still alive of whatever that
 * cohort's current stage asks for. That is what produces a ramp, a plateau, and
 * an ageing-out tail instead of one flat number, and it is the only way the
 * effect of changing a stage boundary is visible at all.
 */

export interface StageSpan {
  readonly stage: PollingStage;
  /** First age-in-days, inclusive, that falls in this stage. */
  readonly startDay: number;
  /** One past the last age. */
  readonly endDay: number;
  /** Average polls/day across this stage. Prefer `pollsByDay` for simulation. */
  readonly pollsPerDay: number;
  /** Exact count of start-to-start poll instants in each stage day. */
  readonly pollsByDay: readonly number[];
  readonly totalPolls: number;
}

export interface LifecycleProfile {
  /** Total days a submission stays in the system — enabled stages only. */
  readonly lifecycleDays: number;
  /** Of those, the days on which it is actually polled. */
  readonly polledLifecycleDays: number;
  readonly pollsPerSubmissionTotal: number;
  readonly spans: readonly StageSpan[];
  /** `cumulativePolls[k]` = polls made across ages `0..k-1`. Length `L + 1`. */
  readonly cumulativePolls: readonly number[];
  /** `cumulativePolledDays[k]` = polled days among ages `0..k-1`. Length `L + 1`. */
  readonly cumulativePolledDays: readonly number[];
  readonly findings: readonly CapacityFinding[];
}

/**
 * Closed-form steady workload for an arrival rate, using the exact poll
 * instants counted by {@link buildLifecycleProfile}.
 *
 * The multiplier here is a derived property of the current lifecycle, never a
 * user-configured "scrapes per submission" assumption. Changing a stage
 * immediately changes the profile and therefore this result.
 */
export function steadyStateJobsPerDay(
  profile: LifecycleProfile,
  newSubmissionsPerDay: number,
): number {
  return Math.max(0, newSubmissionsPerDay) * profile.pollsPerSubmissionTotal;
}

/** Analytical inverse of {@link steadyStateJobsPerDay} for the same profile. */
export function submissionRateForSteadyStateJobs(
  profile: LifecycleProfile,
  jobsPerDay: number,
): number | null {
  if (profile.pollsPerSubmissionTotal <= 0) return null;
  return Math.max(0, jobsPerDay) / profile.pollsPerSubmissionTotal;
}

/**
 * Poll instants in a standalone day, including the instant at the day start.
 *
 * This compatibility helper answers only for the first day. Lifecycle
 * simulation uses {@link pollInstantsByDay}, because a seven-minute interval
 * produces 206 polls on one day and 205 on another; a fractional shortcut can
 * put polls at times that do not exist.
 */
export function pollsPerDayForInterval(intervalMs: number | null): number {
  if (intervalMs === null || intervalMs <= 0) return 0;
  return Math.ceil(MS_PER_DAY / intervalMs);
}

/** Counts `0, interval, 2 * interval, ...` while each instant is inside the stage. */
export function pollInstantsByDay(durationDays: number, intervalMs: number | null): number[] {
  const duration = Math.max(0, Math.floor(durationDays));
  if (intervalMs === null || intervalMs <= 0 || duration === 0) {
    return Array.from({ length: duration }, () => 0);
  }

  return Array.from({ length: duration }, (_, day) => {
    const firstInstant = Math.ceil((day * MS_PER_DAY) / intervalMs);
    const afterLastInstant = Math.ceil(((day + 1) * MS_PER_DAY) / intervalMs);
    return afterLastInstant - firstInstant;
  });
}

export function buildLifecycleProfile(stages: readonly PollingStage[]): LifecycleProfile {
  const findings: CapacityFinding[] = [];
  const spans: StageSpan[] = [];

  let cursor = 0;
  for (const stage of stages) {
    if (!stage.enabled) continue;
    const duration = Math.max(0, Math.floor(stage.durationDays));
    if (duration === 0) continue;
    const pollsByDay = pollInstantsByDay(duration, stage.intervalMs);
    const totalPolls = pollsByDay.reduce((sum, polls) => sum + polls, 0);
    spans.push({
      stage,
      startDay: cursor,
      endDay: cursor + duration,
      pollsPerDay: totalPolls / duration,
      pollsByDay,
      totalPolls,
    });
    cursor += duration;
  }

  const lifecycleDays = cursor;
  const cumulativePolls: number[] = [0];
  const cumulativePolledDays: number[] = [0];

  for (const span of spans) {
    for (let day = span.startDay; day < span.endDay; day += 1) {
      const previousPolls = cumulativePolls[day] ?? 0;
      const previousDays = cumulativePolledDays[day] ?? 0;
      const polls = span.pollsByDay[day - span.startDay] ?? 0;
      cumulativePolls.push(previousPolls + polls);
      cumulativePolledDays.push(previousDays + (polls > 0 ? 1 : 0));
    }
  }

  const pollsPerSubmissionTotal = cumulativePolls[lifecycleDays] ?? 0;
  const polledLifecycleDays = cumulativePolledDays[lifecycleDays] ?? 0;

  if (spans.length === 0) {
    findings.push(
      warning('no_enabled_stages', 'no polling stage is enabled, so nothing is ever scraped'),
    );
  }
  if (polledLifecycleDays < lifecycleDays) {
    findings.push(
      info(
        'dormant_stage_present',
        `${String(lifecycleDays - polledLifecycleDays)} of ${String(lifecycleDays)} lifecycle days are held without polling`,
      ),
    );
  }
  for (const span of spans) {
    const perSubmission = span.totalPolls;
    if (span.stage.intervalMs !== null && perSubmission === 0) {
      findings.push(
        info('sparse_polling', `"${span.stage.label}" has no poll instant inside its duration`),
      );
    }
  }

  return {
    lifecycleDays,
    polledLifecycleDays,
    pollsPerSubmissionTotal,
    spans,
    cumulativePolls,
    cumulativePolledDays,
    findings,
  };
}

export interface StageLoad {
  readonly stageId: string;
  readonly label: string;
  readonly submissions: number;
  readonly polls: number;
}

export interface CohortDay {
  /** 0-based. Day 0 is the first day the system takes any submissions. */
  readonly dayIndex: number;
  readonly phase: 'ramp' | 'steady';
  /** In any enabled stage, dormant included. Sizes storage and retention. */
  readonly activeSubmissions: number;
  /** In a stage that polls. Sizes throughput. */
  readonly polledSubmissions: number;
  readonly scrapeJobs: number;
  readonly jobsPerMinute: number;
  readonly perStage: readonly StageLoad[];
}

export interface SteadyState {
  readonly dayIndex: number;
  readonly activeSubmissions: number;
  readonly polledSubmissions: number;
  readonly scrapeJobs: number;
  readonly jobsPerMinute: number;
}

export interface CohortSimulation {
  readonly days: readonly CohortDay[];
  readonly profile: LifecycleProfile;
  /**
   * The first day every polling age-class is populated, so the job rate stops
   * climbing. `null` when the horizon ends before that.
   */
  readonly jobsPlateauDayIndex: number | null;
  /** The first day the *whole* lifecycle is populated. Later when a tail is dormant. */
  readonly activePlateauDayIndex: number | null;
  /** Polling plateau, available as soon as the horizon reaches the last polled age. */
  readonly pollingSteadyState: SteadyState | null;
  /** Closed-form plateau values. `null` when the horizon never reaches it. */
  readonly steadyState: SteadyState | null;
  readonly totalScrapeJobs: number;
  readonly peakDay: CohortDay | null;
  readonly findings: readonly CapacityFinding[];
}

export interface SimulateCohortsInput {
  readonly newSubmissionsPerDay: number;
  readonly stages: readonly PollingStage[];
  readonly horizonDays: number;
}

/**
 * Rolls the cohorts up per day in `O(horizon + lifecycle)`.
 *
 * On day `d` the live age-classes are exactly `0 .. min(d, L-1)`, each holding
 * one day's arrivals, so every daily figure is one lookup into a prefix sum
 * built once. The obvious nested loop over cohorts is `O(horizon x lifecycle)`
 * and unnecessary; more importantly, summing per day would accumulate floating
 * point error across a 365-day horizon, whereas a prefix lookup does not.
 */
export function simulateCohorts(input: SimulateCohortsInput): CohortSimulation {
  const profile = buildLifecycleProfile(input.stages);
  const arrivals = Math.max(0, input.newSubmissionsPerDay);
  const horizon = Math.max(0, Math.floor(input.horizonDays));
  const lifecycle = profile.lifecycleDays;
  const findings: CapacityFinding[] = [...profile.findings];

  if (arrivals === 0) {
    findings.push(info('no_submissions', 'no submissions enter the system, so there is no load'));
  }

  const days: CohortDay[] = [];
  let totalScrapeJobs = 0;
  let peakDay: CohortDay | null = null;

  const jobsPlateauDay = profile.polledLifecycleDays === 0 ? null : lastPolledAge(profile);
  const activePlateauDay = lifecycle === 0 ? null : lifecycle - 1;

  for (let dayIndex = 0; dayIndex < horizon; dayIndex += 1) {
    const liveAges = Math.min(dayIndex + 1, lifecycle);
    const scrapeJobs = arrivals * (profile.cumulativePolls[liveAges] ?? 0);
    const day: CohortDay = {
      dayIndex,
      phase: jobsPlateauDay !== null && dayIndex >= jobsPlateauDay ? 'steady' : 'ramp',
      activeSubmissions: arrivals * liveAges,
      polledSubmissions: arrivals * (profile.cumulativePolledDays[liveAges] ?? 0),
      scrapeJobs,
      jobsPerMinute: scrapeJobs / MINUTES_PER_DAY,
      perStage: stageLoads(profile, arrivals, liveAges),
    };
    days.push(day);
    totalScrapeJobs += scrapeJobs;
    if (peakDay === null || day.scrapeJobs > peakDay.scrapeJobs) peakDay = day;
  }

  const reachesActiveSteadyState = lifecycle > 0 && horizon >= lifecycle;
  const reachesPollingSteadyState = jobsPlateauDay !== null && horizon > jobsPlateauDay;
  if (!reachesActiveSteadyState && horizon > 0 && lifecycle > 0) {
    findings.push(
      warning(
        'horizon_shorter_than_lifecycle',
        `the ${String(horizon)}-day horizon ends before the ${String(lifecycle)}-day lifecycle fills, so these figures are still ramping`,
      ),
    );
  }

  // Computed in closed form rather than read off the last simulated day: a
  // short horizon would otherwise silently return a ramp value as if it were
  // the plateau.
  const steadyState: SteadyState | null = reachesActiveSteadyState
    ? {
        dayIndex: lifecycle - 1,
        activeSubmissions: arrivals * lifecycle,
        polledSubmissions: arrivals * profile.polledLifecycleDays,
        scrapeJobs: arrivals * profile.pollsPerSubmissionTotal,
        jobsPerMinute: (arrivals * profile.pollsPerSubmissionTotal) / MINUTES_PER_DAY,
      }
    : null;
  const pollingSteadyState: SteadyState | null = reachesPollingSteadyState
    ? {
        dayIndex: jobsPlateauDay,
        activeSubmissions: arrivals * (jobsPlateauDay + 1),
        polledSubmissions: arrivals * profile.polledLifecycleDays,
        scrapeJobs: arrivals * profile.pollsPerSubmissionTotal,
        jobsPerMinute: (arrivals * profile.pollsPerSubmissionTotal) / MINUTES_PER_DAY,
      }
    : null;

  return {
    days,
    profile,
    jobsPlateauDayIndex:
      jobsPlateauDay !== null && horizon > jobsPlateauDay ? jobsPlateauDay : null,
    activePlateauDayIndex:
      activePlateauDay !== null && horizon > activePlateauDay ? activePlateauDay : null,
    pollingSteadyState,
    steadyState,
    totalScrapeJobs,
    peakDay,
    findings,
  };
}

/**
 * The age at which the job rate stops climbing — the last age that polls.
 *
 * Distinct from the age at which the *active* count stops climbing, because a
 * dormant tail stage keeps admitting submissions to the lifecycle long after
 * they have stopped generating work. Reporting one number for both would hide
 * that the workload plateaus days before the population does.
 */
function lastPolledAge(profile: LifecycleProfile): number {
  for (let age = profile.lifecycleDays - 1; age >= 0; age -= 1) {
    const polls = (profile.cumulativePolls[age + 1] ?? 0) - (profile.cumulativePolls[age] ?? 0);
    if (polls > 0) return age;
  }
  return 0;
}

function stageLoads(
  profile: LifecycleProfile,
  arrivals: number,
  liveAges: number,
): readonly StageLoad[] {
  return profile.spans.map((span) => {
    const populated = Math.max(0, Math.min(liveAges, span.endDay) - span.startDay);
    const pollsPerSubmission = span.pollsByDay
      .slice(0, populated)
      .reduce((sum, polls) => sum + polls, 0);
    return {
      stageId: span.stage.id,
      label: span.stage.label,
      submissions: arrivals * populated,
      polls: arrivals * pollsPerSubmission,
    };
  });
}
