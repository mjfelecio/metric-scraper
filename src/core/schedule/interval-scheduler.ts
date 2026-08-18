import { realSleep, type Sleep } from '../retry/sleep.js';

/**
 * Fixed-rate cycle scheduling.
 *
 * A *cycle* is one full pass over a batch; a *session* is a scheduled sequence
 * of them. The interval is measured **start to start**, computed from the
 * session origin rather than from the previous cycle's end, so a session does
 * not drift: `interval 15m` means a cycle begins every 15 minutes whatever the
 * cycles themselves cost. When a cycle overruns its window the next one starts
 * immediately and reports the shortfall as `lagMs`.
 *
 * `intervalMs: 0` collapses this to back-to-back cycles, which is what sustains
 * a target rpm continuously — pacing is then left entirely to the task queue.
 */

export type StopReason = 'completed' | 'max_cycles' | 'duration' | 'cancelled';

export interface IntervalSchedulerOptions {
  /** Time between cycle starts. `0` means start the next cycle immediately. */
  intervalMs: number;
  /** Stop after this many cycles. `null` = unbounded. */
  maxCycles?: number | null | undefined;
  /**
   * Stop *starting* new cycles once this much wall clock has passed. An
   * in-flight cycle always finishes, so a session may overshoot; the summary
   * reports the duration actually observed.
   */
  durationMs?: number | null | undefined;
  signal?: AbortSignal | undefined;
  now?: (() => number) | undefined;
  sleep?: Sleep | undefined;
}

export interface CycleContext {
  /** 1-based. */
  cycle: number;
  /** When this cycle was due: `sessionStart + (cycle - 1) * intervalMs`. */
  scheduledAt: number;
  /** When it actually began. */
  startedAt: number;
  /** `startedAt - scheduledAt`. Greater than zero means the previous cycle overran. */
  lagMs: number;
}

/** Mutable handle the caller can read after the loop ends. */
export interface ScheduleOutcome {
  stopReason: StopReason;
  cyclesStarted: number;
}

/**
 * Yields one `CycleContext` per cycle, waiting between them as configured.
 *
 * Implemented as a generator so the caller's `for await` body *is* the cycle:
 * the generator only resumes once the body has finished, which is what lets it
 * measure overrun and schedule the next start from the session origin.
 *
 * ```ts
 * const outcome: ScheduleOutcome = { stopReason: 'completed', cyclesStarted: 0 };
 * for await (const cycle of scheduleCycles(options, outcome)) {
 *   await runOneCycle(cycle);
 * }
 * ```
 */
export async function* scheduleCycles(
  options: IntervalSchedulerOptions,
  outcome: ScheduleOutcome = { stopReason: 'completed', cyclesStarted: 0 },
): AsyncGenerator<CycleContext, ScheduleOutcome> {
  const now = options.now ?? ((): number => Date.now());
  const sleep = options.sleep ?? realSleep;
  const intervalMs = Math.max(0, options.intervalMs);
  const maxCycles = options.maxCycles ?? null;
  const durationMs = options.durationMs ?? null;
  const { signal } = options;

  // Read through a function: `signal.aborted` flips underneath an await, and
  // narrowing it inline would let the compiler assume it cannot have changed.
  const isAborted = (): boolean => signal?.aborted ?? false;

  const sessionStartedAt = now();
  let cycle = 0;

  const stop = (reason: StopReason): ScheduleOutcome => {
    outcome.stopReason = reason;
    outcome.cyclesStarted = cycle;
    return outcome;
  };

  for (;;) {
    if (isAborted()) return stop('cancelled');
    if (maxCycles !== null && cycle >= maxCycles) return stop('max_cycles');

    const scheduledAt = sessionStartedAt + cycle * intervalMs;

    // Checked against the *scheduled* start, before sleeping. A session with
    // `duration 10m` and `interval 15m` must stop now rather than idle for a
    // quarter of an hour only to discover it was already past its deadline.
    if (durationMs !== null && scheduledAt - sessionStartedAt >= durationMs) {
      return stop('duration');
    }

    const waitMs = scheduledAt - now();
    if (waitMs > 0) {
      try {
        await sleep(waitMs, signal);
      } catch {
        // The only way `sleep` rejects is an abort; anything else would be a
        // programming error in the injected clock, and stopping is still right.
        return stop('cancelled');
      }
      if (isAborted()) return stop('cancelled');
    }

    // Re-checked against the real clock: a cycle that overran may have carried
    // the session past its deadline even though the schedule said otherwise.
    if (durationMs !== null && now() - sessionStartedAt >= durationMs) {
      return stop('duration');
    }

    cycle += 1;
    const startedAt = now();
    outcome.cyclesStarted = cycle;

    yield { cycle, scheduledAt, startedAt, lagMs: Math.max(0, startedAt - scheduledAt) };
  }
}
