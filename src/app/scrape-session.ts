import { randomUUID } from 'node:crypto';

import { type AppConfig } from '../config/env.js';
import { type Logger, nullLogger } from '../core/logging/logger.js';
import { type BandwidthAggregator } from '../core/metrics/bandwidth.js';
import { ThroughputTimeline, type ThroughputSample } from '../core/metrics/throughput-timeline.js';
import { ScrapeError } from '../core/models/errors.js';
import { type InputRecord } from '../core/models/input.js';
import { type Platform } from '../core/models/platform.js';
import { type SnapshotSink } from '../core/output/snapshot-sink.js';
import { type ProxyPoolStats } from '../core/scraper/pool-ports.js';
import { type RunSummary } from '../core/models/run-summary.js';
import {
  type CycleSummary,
  type SessionSummary,
  type StopReasonValue,
} from '../core/models/session-summary.js';
import { realSleep } from '../core/retry/sleep.js';
import { buildSessionSummary } from '../core/runner/build-session-summary.js';
import { type JobCompletedEvent, type RunCounts, type RunProgress } from '../core/runner/types.js';
import {
  scheduleCycles,
  type CycleContext,
  type ScheduleOutcome,
} from '../core/schedule/interval-scheduler.js';
import { JsonlFileSink } from '../infrastructure/output/jsonl-file-sink.js';
import { ProxyEventLog } from '../infrastructure/output/proxy-event-log.js';
import {
  writeRunSummary,
  writeSessionSummary,
  type SessionPaths,
} from '../infrastructure/output/run-paths.js';

import {
  buildRunner,
  createProxySupply,
  createSessionPool,
  type BuiltRunner,
  type RunnerOverrides,
} from './composition.js';

const DEFAULT_SAMPLE_INTERVAL_MS = 1_000;

/**
 * The run id given to one cycle's own `ScrapeRunner.run` — distinct per
 * cycle, so cycle N and cycle N+1 are never confused with one another (e.g.
 * when excluding "this run" from its own bandwidth baseline — see R8 in
 * `bandwidth-refresh.ts`, the other place this must be reproduced exactly).
 */
export function cycleRunId(sessionId: string, cycle: number): string {
  return `${sessionId}-cycle-${String(cycle).padStart(3, '0')}`;
}

export interface SessionScheduleOptions {
  /** Time between cycle starts. `0` = back-to-back. */
  intervalMs: number;
  /** Stop starting new cycles after this much wall clock. `null` = unbounded. */
  durationMs: number | null;
  maxCycles: number | null;
}

/** Live view of a session, emitted on the sampler's cadence. */
export interface SessionProgress {
  state: 'running' | 'waiting';
  cycle: number;
  cyclesCompleted: number;
  plannedCycles: number | null;
  /** Progress within the cycle currently running. */
  processed: number;
  total: number;
  /** Cumulative across the whole session. */
  completed: number;
  successes: number;
  failures: number;
  retries: number;
  inFlight: number;
  elapsedMs: number;
  /** Instantaneous, from the most recent sample. */
  requestsPerMinute: number;
  peakRequestsPerMinute: number;
  sustainedTargetMs: number;
  /** Epoch ms of the next scheduled cycle start; `null` when back-to-back. */
  nextCycleAt: number | null;
  stalled: boolean;
  /**
   * The pool as it stands right now.
   *
   * Sampled on the same cadence as the throughput timeline rather than per
   * result: `getStats` is O(proxies), and a pool view is only useful at a
   * cadence a human can read anyway.
   */
  proxies: ProxyPoolStats;
}

export interface RunSessionOptions {
  sessionId?: string | undefined;
  records: readonly InputRecord[];
  platform: Platform | null;
  counts: RunCounts;
  config: AppConfig;
  logger?: Logger | undefined;
  overrides?: RunnerOverrides | undefined;
  schedule: SessionScheduleOptions;
  paths: SessionPaths;
  signal?: AbortSignal | undefined;
  /** Timeline resolution. */
  sampleIntervalMs?: number | undefined;
  maxSamples?: number | undefined;
  /** Persist the session summary when the session ends. Default `true`. */
  persistSummary?: boolean | undefined;
  onSample?: ((sample: ThroughputSample) => void) | undefined;
  onProgress?: ((progress: SessionProgress) => void) | undefined;
  onCycleStart?: ((context: CycleContext) => void) | undefined;
  onCycleEnd?: ((cycle: CycleSummary) => void) | undefined;
  /** Test seam fired after one cycle's bytes are folded into the cumulative base. */
  onBandwidthFold?: ((totalBytes: number) => void) | undefined;
  /**
   * Every finished URL, tagged with the cycle it belongs to.
   *
   * The session itself only needs counters, but the snapshot carries the actual
   * scraped metrics and this is the one place they pass through — without this
   * hook a caller would have to re-read the JSONL to see what was collected.
   */
  onResult?: ((event: JobCompletedEvent, context: CycleContext) => void) | undefined;
  now?: (() => number) | undefined;
  /**
   * Builds the runner for one cycle. Overridable for tests, mirroring
   * `ScrapeRunnerDeps.createQueue`, so cycle-level failure handling can be
   * exercised without contriving an unwritable filesystem.
   */
  createRunner?:
    ((context: { cycle: number; sink: SnapshotSink }) => Promise<BuiltRunner>) | undefined;
}

/**
 * Runs a batch repeatedly on a schedule and reports the whole session.
 *
 * A *cycle* is one full pass over the batch — exactly what `ScrapeRunner.run`
 * already does — and a *session* is a scheduled sequence of them. Framing it
 * this way means the runner, retry policy, pacing, metrics and output layer are
 * reused untouched; the only new behaviour is the loop and the aggregation.
 *
 * Three properties this function is responsible for, which the requirement
 * calls for explicitly:
 *
 * - **A long run finishes and reports.** A cycle that throws is recorded and
 *   the session carries on. Only an unwritable output is fatal, matching the
 *   runner's existing rule that losing rows is never acceptable.
 * - **Nothing stalls silently.** A watchdog flags a cycle that stops making
 *   progress while work is still in flight.
 * - **Retries never inflate throughput.** They are accumulated separately and
 *   only ever reported in their own section.
 */
export async function runSession(options: RunSessionOptions): Promise<SessionSummary> {
  const logger = options.logger ?? nullLogger;
  const now = options.now ?? ((): number => Date.now());
  const sessionId = options.sessionId ?? randomUUID();
  const { config, paths, schedule, records } = options;
  const sampleIntervalMs = options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;

  const sessionLogger = logger.child({ session_id: sessionId });
  const startedAtMs = now();
  const startedAt = new Date(startedAtMs);

  const timeline = new ThroughputTimeline({
    startedAtMs,
    maxSamples: options.maxSamples,
    now,
  });

  // Built once for the whole session. Proxy and session cooldowns are measured
  // in minutes, so rebuilding the pools every cycle would un-bench every proxy
  // that had just been benched for failing.
  //
  // The event log spans the session for the same reason: a proxy benched in
  // cycle 2 and released in cycle 5 is one story, and splitting it per cycle
  // would make it unreadable.
  const proxyEvents = new ProxyEventLog({
    filePath: paths.proxyEvents,
    context: { session_id: sessionId },
    logger: sessionLogger,
  });
  const concurrency = options.overrides?.concurrency ?? config.concurrency;
  const targetRpm = options.overrides?.targetRpm ?? config.targetRpm;

  const proxySupply = createProxySupply(
    config,
    sessionLogger,
    (event) => {
      proxyEvents.record(event);
    },
    concurrency,
  );
  const proxyProvider = proxySupply.provider;
  // Stocked before the first cycle so it does not start against an empty pool,
  // then topped up in the background for the rest of the session.
  await proxySupply.source?.start();
  const sessionPool = await createSessionPool(config, sessionLogger);

  // Session-cumulative counters, updated as results land rather than derived
  // from cycle summaries, so the live timeline is accurate mid-cycle.
  let completed = 0;
  let successes = 0;
  let failures = 0;
  let retries = 0;
  const latenciesMs: number[] = [];

  // `buildRunner` hands back a fresh `BandwidthAggregator` per cycle (proxy and
  // session pools are reused across cycles, but the aggregator is not), so the
  // running total has to be assembled by hand: `bandwidthBaseBytes` is what
  // finished cycles already measured, and `currentBandwidth` is this cycle's
  // live aggregator. `null` for the whole session when `METRICS_BANDWIDTH` is
  // off, which keeps every live sample's `bytes` at the documented `0`
  // sentinel rather than a measured-looking number.
  let currentBandwidth: BandwidthAggregator | null = null;
  let bandwidthBaseBytes = 0;
  const liveBandwidthBytes = (): number =>
    bandwidthBaseBytes + (currentBandwidth?.view().totalBytes ?? 0);

  const cycles: CycleSummary[] = [];
  let currentCycle = 0;
  let liveProgress: RunProgress | null = null;
  // Read through a function: the only writer is a callback, so narrowing the
  // variable inline would let the compiler assume it is still null.
  const live = (): RunProgress | null => liveProgress;
  let nextCycleAt: number | null = null;
  let rowsWritten = 0;
  let stalled = false;
  let latestRpm = 0;

  // Stall watchdog state. A cycle is stalled when work is in flight but nothing
  // has completed for a long time relative to the per-request timeout.
  const stallThresholdMs = Math.max(30_000, config.requestTimeoutMs * 3);
  let lastProgressAtMs = startedAtMs;
  let lastCompletedSeen = 0;

  const buildProgress = (): SessionProgress => ({
    state: live() === null ? 'waiting' : 'running',
    cycle: currentCycle,
    cyclesCompleted: cycles.length,
    plannedCycles: schedule.maxCycles,
    processed: live()?.processed ?? 0,
    total: live()?.total ?? records.length,
    completed,
    successes,
    failures,
    retries,
    inFlight: live()?.inFlight ?? 0,
    elapsedMs: Math.max(0, now() - startedAtMs),
    requestsPerMinute: latestRpm,
    peakRequestsPerMinute: timeline.peakRequestsPerMinute(),
    sustainedTargetMs: timeline.sustained(targetRpm).windowMs,
    nextCycleAt,
    stalled,
    proxies: proxyProvider.getStats(),
  });

  // The sampler runs on its own fixed cadence rather than off `onProgress`.
  // Evenly spaced samples matter: an idle gap between cycles must appear as a
  // real stretch of zero on the graph, and progress callbacks stop entirely
  // between cycles.
  let sampling = true;
  // Interrupts the sampler's sleep on shutdown. Without it every session would
  // pay up to a full sample interval of dead time before it could report.
  const samplerStop = new AbortController();
  const sampler = (async (): Promise<void> => {
    while (sampling) {
      try {
        await realSleep(sampleIntervalMs, samplerStop.signal);
      } catch {
        break;
      }
      if (!sampling) break;

      const inFlight = live()?.inFlight ?? 0;
      const sample = timeline.record({
        completed,
        successes,
        failures,
        retries,
        inFlight,
        cycle: currentCycle,
        bytes: liveBandwidthBytes(),
      });

      if (sample !== null) {
        latestRpm = sample.requestsPerMinute;
        options.onSample?.(sample);
      }

      const at = now();
      if (completed !== lastCompletedSeen) {
        lastCompletedSeen = completed;
        lastProgressAtMs = at;
      } else if (inFlight > 0 && at - lastProgressAtMs >= stallThresholdMs && !stalled) {
        stalled = true;
        sessionLogger.warn(
          { cycle: currentCycle, in_flight: inFlight, stalled_for_ms: at - lastProgressAtMs },
          'session appears stalled: work in flight but nothing completing',
        );
      }

      options.onProgress?.(buildProgress());
    }
  })();

  const outcome: ScheduleOutcome = { stopReason: 'completed', cyclesStarted: 0 };
  let stopReason: StopReasonValue = 'completed';
  let fatalError: ScrapeError | null = null;

  try {
    for await (const context of scheduleCycles(
      {
        intervalMs: schedule.intervalMs,
        maxCycles: schedule.maxCycles,
        durationMs: schedule.durationMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        now,
      },
      outcome,
    )) {
      currentCycle = context.cycle;
      nextCycleAt = schedule.intervalMs > 0 ? context.scheduledAt + schedule.intervalMs : null;
      lastProgressAtMs = now();
      options.onCycleStart?.(context);

      const cycleStartedAt = new Date(context.startedAt);
      const cycleSummaryPath = paths.cycleSummary(context.cycle);
      let summary: RunSummary | null = null;
      let cycleError: { code: string; message: string } | null = null;

      try {
        // A fresh sink per cycle: `ScrapeRunner.run` closes the sink it is
        // given, and `JsonlFileSink` refuses writes afterwards. The file is
        // opened in append mode, so reopening the same path is exactly the
        // append-only time series the output contract describes.
        const sink = new JsonlFileSink({ filePath: paths.snapshots });

        const built =
          options.createRunner === undefined
            ? await buildRunner({
                config,
                logger: sessionLogger,
                sink,
                ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
                proxyProvider,
                sessionPool,
              })
            : await options.createRunner({ cycle: context.cycle, sink });

        currentBandwidth = built.bandwidth;

        const result = await built.runner.run(records, {
          runId: cycleRunId(sessionId, context.cycle),
          platform: options.platform,
          counts: options.counts,
          summaryPath: cycleSummaryPath,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          onProgress: (progress) => {
            liveProgress = progress;
          },
          onResult: (event) => {
            completed += 1;
            if (event.snapshot.status === 'ok') successes += 1;
            else failures += 1;
            // Accumulated apart from `completed` so no throughput figure can
            // ever be inflated by retry volume.
            retries += event.retries;
            latenciesMs.push(event.snapshot.latency_ms);
            options.onResult?.(event, context);
          },
        });

        summary = result.summary;
        rowsWritten += result.summary.output.rows_written;

        try {
          await writeRunSummary(cycleSummaryPath, result.summary);
        } catch (error) {
          // A missing cycle summary must not discard the rows that cycle wrote.
          sessionLogger.warn(
            {
              cycle: context.cycle,
              path: cycleSummaryPath,
              message: error instanceof Error ? error.message : String(error),
            },
            'could not write cycle summary',
          );
        }

        if (result.fatalError !== null) {
          cycleError = { code: result.fatalError.code, message: result.fatalError.message };
          // Losing rows is the one thing worth ending a session over; any other
          // cycle-level failure is data, and the next cycle may well succeed.
          if (result.fatalError.code === 'output_error') {
            fatalError = result.fatalError;
          }
        }
      } catch (error) {
        const scrapeError = ScrapeError.from(error);
        cycleError = { code: scrapeError.code, message: scrapeError.message };
        sessionLogger.error(
          { cycle: context.cycle, error_code: scrapeError.code, message: scrapeError.message },
          'cycle failed; session continues',
        );
      }

      liveProgress = null;
      // The aggregator dies with the cycle's runner; fold what it saw into the
      // session-cumulative base before dropping the reference, so a live
      // sample taken between cycles keeps reading the run's true total instead
      // of momentarily dropping back to whatever the next cycle has measured
      // so far.
      const finishedCycleBytes = currentBandwidth?.view().totalBytes ?? 0;
      currentBandwidth = null;
      bandwidthBaseBytes += finishedCycleBytes;
      options.onBandwidthFold?.(bandwidthBaseBytes);
      const finishedAtMs = now();
      const cycleSummary: CycleSummary = {
        cycle: context.cycle,
        scheduled_at: new Date(context.scheduledAt).toISOString(),
        started_at: cycleStartedAt.toISOString(),
        finished_at: new Date(finishedAtMs).toISOString(),
        lag_ms: context.lagMs,
        overran:
          schedule.intervalMs > 0 && finishedAtMs - context.scheduledAt > schedule.intervalMs,
        summary,
        error: cycleError,
      };
      cycles.push(cycleSummary);
      options.onCycleEnd?.(cycleSummary);

      if (fatalError !== null) {
        stopReason = 'fatal';
        break;
      }
    }

    if (stopReason !== 'fatal') {
      stopReason = outcome.stopReason;
    }
  } finally {
    sampling = false;
    samplerStop.abort();
    await sampler;
  }

  // One last sample so the timeline reflects the settled state rather than
  // ending mid-cycle.
  const finalSample = timeline.record({
    completed,
    successes,
    failures,
    retries,
    inFlight: 0,
    cycle: 0,
    bytes: liveBandwidthBytes(),
  });
  if (finalSample !== null) options.onSample?.(finalSample);

  nextCycleAt = null;
  const finishedAt = new Date(now());

  const sessionSummary = buildSessionSummary({
    sessionId,
    platform: options.platform,
    startedAt,
    finishedAt,
    counts: options.counts,
    cycles,
    latenciesMs,
    timeline,
    schedule: {
      intervalMs: schedule.intervalMs,
      durationMs: schedule.durationMs,
      maxCycles: schedule.maxCycles,
      stopReason,
    },
    concurrency,
    targetRpm,
    stalled,
    proxyStats: proxyProvider.getStats(),
    snapshotsPath: paths.snapshots,
    summaryPath: paths.summary,
    cyclesDir: paths.cyclesDir,
    rowsWritten,
  });

  proxySupply.source?.stop();
  await proxyEvents.close();

  if (options.persistSummary !== false) {
    try {
      await writeSessionSummary(paths.summary, sessionSummary);
    } catch (error) {
      sessionLogger.warn(
        { path: paths.summary, message: error instanceof Error ? error.message : String(error) },
        'could not write session summary',
      );
    }
  }

  sessionLogger.info(
    {
      cycles: sessionSummary.cycles.started,
      requests: sessionSummary.totals.requests,
      active_rpm: Math.round(sessionSummary.throughput.active_rpm),
      sustained_ms: sessionSummary.throughput.sustained_target_ms,
      stop_reason: stopReason,
    },
    'session finished',
  );

  return sessionSummary;
}
