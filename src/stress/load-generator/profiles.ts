import {
  CLEAN_WORKLOAD_PROFILE,
  FAILURE_HEAVY_WORKLOAD_PROFILE,
  NORMAL_WORKLOAD_PROFILE,
  type WorkloadProfile,
} from '../workload/workload-profile.js';
import { type PlatformDistribution } from '../workload/synthetic-input.js';

export const STRESS_PROFILE_NAMES = [
  'baseline',
  'acceptance',
  'burst',
  'sustained',
  'failure-heavy',
] as const;
export type StressProfileName = (typeof STRESS_PROFILE_NAMES)[number];

export interface StressPhase {
  name: string;
  platform: PlatformDistribution;
  /** `0` disables admission pacing entirely -- used by the burst phase. */
  targetRpm: number;
  concurrency?: number;
  burst?: number;
  /** Mutually exclusive with `totalJobs`. */
  durationMs?: number;
  totalJobs?: number;
}

export interface StressPlan {
  profile: StressProfileName;
  workload: WorkloadProfile;
  phases: StressPhase[];
}

/** `specification.txt` §6: the take-home's own throughput/duration numbers. */
export const ACCEPTANCE_TARGET_RPM = 500;
export const ACCEPTANCE_DURATION_MS = 10 * 60_000;

/**
 * Derived from the brief's own stated context, not from the take-home spec:
 * 300-500 new submissions/day, each polled every 15 minutes for up to 30
 * days, means up to ~15,000 actively-polled submissions in any 15-minute
 * window -- roughly 1000 req/min steady state. This is *informational*, not
 * a pass/fail bar; `acceptance` (above) remains the strict gate.
 */
export const SUSTAINED_TARGET_RPM = 1_000;
export const SUSTAINED_DURATION_MS = 20 * 60_000;

const BASELINE_TARGET_RPM = 30;
const BASELINE_DURATION_MS = 60_000;

const BURST_WARMUP_RPM = 30;
const BURST_WARMUP_DURATION_MS = 15_000;
const BURST_JOB_COUNT = 300;
const BURST_RECOVERY_DURATION_MS = 30_000;

const FAILURE_HEAVY_TARGET_RPM = 200;
const FAILURE_HEAVY_DURATION_MS = 120_000;

const RAMP_STEPS = 5;

export interface StressPlanOptions {
  profile: StressProfileName;
  platform: PlatformDistribution;
  concurrency: number;
  /** Overrides the profile's default steady-state rate. */
  targetRpm?: number | undefined;
  /** Overrides the profile's default duration (duration-based profiles only). */
  durationMs?: number | undefined;
  /** Overrides the profile's default injected-batch size (`burst` only). */
  totalJobs?: number | undefined;
  /** `0`/omitted disables the ramp; otherwise a staircase of this total length precedes the steady phase. */
  rampUpMs?: number | undefined;
  burst?: number | undefined;
  /** Overrides the profile's default workload mix. */
  workload?: WorkloadProfile | undefined;
}

export function buildStressPlan(options: StressPlanOptions): StressPlan {
  const workload = options.workload ?? defaultWorkloadFor(options.profile);
  const phases = buildPhases(options);
  return { profile: options.profile, workload, phases };
}

function defaultWorkloadFor(profile: StressProfileName): WorkloadProfile {
  switch (profile) {
    case 'baseline':
      return CLEAN_WORKLOAD_PROFILE;
    case 'failure-heavy':
      return FAILURE_HEAVY_WORKLOAD_PROFILE;
    case 'acceptance':
    case 'burst':
    case 'sustained':
      return NORMAL_WORKLOAD_PROFILE;
  }
}

function buildPhases(options: StressPlanOptions): StressPhase[] {
  const { platform, concurrency } = options;

  switch (options.profile) {
    case 'baseline':
      return withRampUp(
        {
          name: 'baseline',
          platform,
          targetRpm: options.targetRpm ?? BASELINE_TARGET_RPM,
          concurrency,
          durationMs: options.durationMs ?? BASELINE_DURATION_MS,
          ...(options.burst !== undefined ? { burst: options.burst } : {}),
        },
        options.rampUpMs,
      );

    case 'acceptance':
      return withRampUp(
        {
          name: 'acceptance',
          platform,
          targetRpm: options.targetRpm ?? ACCEPTANCE_TARGET_RPM,
          concurrency,
          durationMs: options.durationMs ?? ACCEPTANCE_DURATION_MS,
          ...(options.burst !== undefined ? { burst: options.burst } : {}),
        },
        options.rampUpMs,
      );

    case 'sustained':
      return withRampUp(
        {
          name: 'sustained',
          platform,
          targetRpm: options.targetRpm ?? SUSTAINED_TARGET_RPM,
          concurrency,
          durationMs: options.durationMs ?? SUSTAINED_DURATION_MS,
          ...(options.burst !== undefined ? { burst: options.burst } : {}),
        },
        options.rampUpMs,
      );

    case 'failure-heavy':
      return withRampUp(
        {
          name: 'failure-heavy',
          platform,
          targetRpm: options.targetRpm ?? FAILURE_HEAVY_TARGET_RPM,
          concurrency,
          durationMs: options.durationMs ?? FAILURE_HEAVY_DURATION_MS,
          ...(options.burst !== undefined ? { burst: options.burst } : {}),
        },
        options.rampUpMs,
      );

    case 'burst':
      // No ramp-up here: the whole point of this profile is the *sudden*
      // step from warm to a flood, not a graceful climb into it.
      return [
        {
          name: 'warmup',
          platform,
          targetRpm: BURST_WARMUP_RPM,
          concurrency,
          durationMs: BURST_WARMUP_DURATION_MS,
        },
        {
          name: 'burst',
          platform,
          // 0 = pacing disabled entirely; only concurrency/queue bound admission,
          // which is exactly the spike this profile exists to observe.
          targetRpm: 0,
          concurrency,
          totalJobs: options.totalJobs ?? BURST_JOB_COUNT,
        },
        {
          name: 'recovery',
          platform,
          targetRpm: options.targetRpm ?? BURST_WARMUP_RPM,
          concurrency,
          durationMs: BURST_RECOVERY_DURATION_MS,
        },
      ];
  }
}

/** Staircase ramp: `RAMP_STEPS` phases climbing to `steady.targetRpm`, each `rampUpMs / RAMP_STEPS` long. */
function withRampUp(steady: StressPhase, rampUpMs: number | undefined): StressPhase[] {
  if (rampUpMs === undefined || rampUpMs <= 0) return [steady];

  const stepDurationMs = Math.max(1_000, Math.floor(rampUpMs / RAMP_STEPS));
  const rampPhases: StressPhase[] = Array.from({ length: RAMP_STEPS }, (_, step) => {
    const fraction = (step + 1) / RAMP_STEPS;
    return {
      name: `ramp-${step + 1}-of-${RAMP_STEPS}`,
      platform: steady.platform,
      targetRpm: Math.max(1, Math.round(steady.targetRpm * fraction)),
      durationMs: stepDurationMs,
      ...(steady.concurrency !== undefined ? { concurrency: steady.concurrency } : {}),
    };
  });
  return [...rampPhases, steady];
}
