import { MockAgent } from 'undici';

import { buildRunner, createProxySupply, createSessionPool } from '../../app/composition.js';
import { type AppConfig } from '../../config/env.js';
import { type Logger } from '../../core/logging/logger.js';
import { type BandwidthAggregator } from '../../core/metrics/bandwidth.js';
import {
  ThroughputTimeline,
  type ThroughputSample,
} from '../../core/metrics/throughput-timeline.js';
import { type RunSummary } from '../../core/models/run-summary.js';
import { type RunProgress } from '../../core/runner/types.js';
import { FetchHttpClient } from '../../infrastructure/http/fetch-http-client.js';
import { JsonlFileSink } from '../../infrastructure/output/jsonl-file-sink.js';
import { timestampSlug } from '../../infrastructure/output/run-paths.js';
import {
  combinedRequestLatencyMs,
  registerAllMockUpstreams,
} from '../upstream/combined-mock-upstream.js';
import {
  createMockDefaultDispatcher,
  createMockDispatcherFactory,
} from '../upstream/proxy-mock-dispatcher.js';
import { generateSyntheticInput } from '../workload/synthetic-input.js';
import { type WorkloadProfile } from '../workload/workload-profile.js';

import { type StressPhase, type StressPlan } from './profiles.js';

export interface LoadGeneratorOptions {
  config: AppConfig;
  logger: Logger;
  plan: StressPlan;
  outputDir: string;
  /** Stops the whole load test (all remaining phases) early, e.g. Ctrl-C. */
  signal?: AbortSignal | undefined;
  onPhaseStart?: ((phase: StressPhase, index: number) => void) | undefined;
  onPhaseEnd?: ((result: PhaseResult) => void) | undefined;
  /** Memory sampling cadence. Default 1000ms. */
  memorySampleIntervalMs?: number | undefined;
  /**
   * Queue-depth and throughput-timeline sampling cadence. Defaults to an
   * adaptive value sized off the run's target rate -- see
   * `adaptiveSampleIntervalMs`'s doc comment.
   *
   * Must be a *fixed* cadence, not once per completed job: job completions
   * are bursty (concurrent jobs finish close together, then a gap while the
   * next batch is in flight), and `ThroughputTimeline.sustained()` computes
   * each sample's instantaneous rate from the *wall-clock* gap since the
   * previous sample -- feeding it irregularly makes a sparse, low-density
   * gap read as a throughput dip even when the run's overall rate is
   * healthy. This mirrors `scrape-session.ts`'s own fixed-cadence sampler.
   */
  sampleIntervalMs?: number | undefined;
}

export interface PhaseResult {
  phase: StressPhase;
  index: number;
  runId: string;
  summary: RunSummary;
  fatalError: string | null;
  startedAt: Date;
  finishedAt: Date;
}

export interface QueueSample {
  tMs: number;
  phaseIndex: number;
  queued: number;
  inFlight: number;
  concurrency: number;
}

export interface MemorySample {
  tMs: number;
  rssBytes: number;
}

export interface LoadGeneratorResult {
  plan: StressPlan;
  phases: PhaseResult[];
  timeline: ThroughputTimeline;
  timelineSamples: readonly ThroughputSample[];
  queueSamples: readonly QueueSample[];
  memorySamples: readonly MemorySample[];
  startedAt: Date;
  finishedAt: Date;
  snapshotsPath: string;
}

/**
 * Runs every phase of a `StressPlan` in sequence against the mock upstream,
 * sharing one proxy provider and session pool across phases -- the same
 * reason `scrape-session.ts` reuses them across cycles: cooldowns are
 * measured in minutes, so rebuilding the pool per phase would silently
 * un-bench every proxy that had just been benched for failing.
 *
 * `ScrapeRunner.run()` takes one fixed `targetRpm` for its whole call and has
 * no notion of a mid-run rate change, so "ramp-up" here means several short
 * phases at increasing `targetRpm` (see `profiles.ts`) rather than a smooth
 * curve -- a deliberate scoping decision, not an oversight.
 */
export async function runLoadTest(options: LoadGeneratorOptions): Promise<LoadGeneratorResult> {
  const { config, logger, plan } = options;
  const startedAt = new Date();

  const workload = normalizeWorkloadForConfig(plan.workload, config);
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  const instagramDocIds = {
    postDocId: config.instagram.postDocId,
    clipsDocId: config.instagram.clipsDocId,
  };
  registerAllMockUpstreams(mockAgent, workload, instagramDocIds);
  const latencyMs = (opts: Parameters<typeof combinedRequestLatencyMs>[0]): number =>
    combinedRequestLatencyMs(opts, workload, instagramDocIds);

  const proxySupply = createProxySupply(config, logger, undefined, config.concurrency);
  await proxySupply.source?.start();
  const sessionPool = await createSessionPool(config, logger);

  const slug = `stress-${timestampSlug(startedAt)}`;
  const snapshotsPath = `${options.outputDir}/${slug}.jsonl`;

  const timeline = new ThroughputTimeline({ startedAtMs: startedAt.getTime() });
  const queueSamples: QueueSample[] = [];
  const memorySamples: MemorySample[] = [];
  let cumulativeRetries = 0;
  let priorPhasesSuccesses = 0;
  let priorPhasesFailures = 0;
  let priorPhasesCompleted = 0;

  // Updated by `onProgress` (fires per completed job, bursty); sampled on a
  // fixed cadence below rather than fed directly -- see `sampleIntervalMs`'s
  // doc comment on why.
  let latestProgress: RunProgress | null = null;
  let currentPhaseIndex = 0;
  let currentConcurrency = config.concurrency;
  let currentBandwidth: BandwidthAggregator | null = null;

  const memoryTimer = setInterval(() => {
    memorySamples.push({
      tMs: Date.now() - startedAt.getTime(),
      rssBytes: process.memoryUsage().rss,
    });
  }, options.memorySampleIntervalMs ?? 1_000);
  memoryTimer.unref();

  const sampleIntervalMs = options.sampleIntervalMs ?? adaptiveSampleIntervalMs(plan);
  const sampleTimer = setInterval(() => {
    const progress = latestProgress;
    if (progress === null) return;
    queueSamples.push({
      tMs: Date.now() - startedAt.getTime(),
      phaseIndex: currentPhaseIndex,
      queued: progress.queued,
      inFlight: progress.inFlight,
      concurrency: currentConcurrency,
    });
    timeline.record({
      completed: priorPhasesCompleted + progress.processed,
      successes: priorPhasesSuccesses + progress.successful,
      failures: priorPhasesFailures + progress.failed,
      retries: cumulativeRetries,
      inFlight: progress.inFlight,
      cycle: currentPhaseIndex,
      bytes: currentBandwidth?.view().totalBytes ?? 0,
    });
  }, sampleIntervalMs);
  sampleTimer.unref();

  const phases: PhaseResult[] = [];
  let syntheticIndexCursor = 0;

  try {
    for (let index = 0; index < plan.phases.length; index += 1) {
      const phase = plan.phases[index];
      if (phase === undefined) continue;
      if (options.signal?.aborted === true) break;

      options.onPhaseStart?.(phase, index);
      const phaseStartedAt = new Date();

      const recordCount = computePhaseRecordCount(phase);
      const records = generateSyntheticInput({
        platform: phase.platform,
        count: recordCount,
        startIndex: syntheticIndexCursor,
      });
      syntheticIndexCursor += recordCount;

      const sink = new JsonlFileSink({ filePath: snapshotsPath });
      const built = await buildRunner({
        config,
        logger,
        sink,
        proxyProvider: proxySupply.provider,
        sessionPool,
        overrides: {
          concurrency: phase.concurrency ?? config.concurrency,
          targetRpm: phase.targetRpm,
          ...(phase.burst !== undefined ? { burst: phase.burst } : {}),
        },
        transport: (bandwidthSink) =>
          new FetchHttpClient({
            defaultTimeoutMs: config.requestTimeoutMs,
            dispatcherFactory: createMockDispatcherFactory(mockAgent, bandwidthSink, latencyMs),
            defaultDispatcher: createMockDefaultDispatcher(mockAgent, bandwidthSink, latencyMs),
          }),
      });

      currentPhaseIndex = index;
      currentConcurrency = phase.concurrency ?? config.concurrency;
      currentBandwidth = built.bandwidth;
      latestProgress = null;

      const phaseSignal =
        phase.durationMs !== undefined
          ? mergeSignals([AbortSignal.timeout(phase.durationMs), options.signal])
          : options.signal;

      const result = await built.runner.run(records, {
        platform: phase.platform === 'mixed' ? null : phase.platform,
        ...(phaseSignal !== undefined ? { signal: phaseSignal } : {}),
        onProgress: (progress: RunProgress) => {
          latestProgress = progress;
        },
      });

      priorPhasesCompleted += result.summary.totals.requests;
      priorPhasesSuccesses += result.summary.totals.successes;
      priorPhasesFailures += result.summary.totals.failures;
      cumulativeRetries += result.summary.retries.total_retries;

      const phaseResult: PhaseResult = {
        phase,
        index,
        runId: result.runId,
        summary: result.summary,
        fatalError: result.fatalError?.message ?? null,
        startedAt: phaseStartedAt,
        finishedAt: new Date(),
      };
      phases.push(phaseResult);
      options.onPhaseEnd?.(phaseResult);

      if (result.fatalError !== null) break;
    }
  } finally {
    clearInterval(memoryTimer);
    proxySupply.source?.stop();
  }

  return {
    plan,
    phases,
    timeline,
    timelineSamples: timeline.samples(),
    queueSamples,
    memorySamples,
    startedAt,
    finishedAt: new Date(),
    snapshotsPath,
  };
}

/**
 * Sized off the run's steady/final phase (the one `buildStressReport`
 * actually evaluates `sustained()` against): too fine a cadence relative to
 * the target rate makes each sample's expected completion count so small
 * that pure scheduling jitter -- which half-second a job happens to land in
 * -- reads as a throughput dip even at a perfectly healthy rate. Aiming for
 * ~5 expected completions per sample keeps that quantization noise small.
 * Clamped to [250ms, 2000ms]: fine enough for a real 500-1000rpm acceptance/
 * sustained run, coarse enough that a low-rate dev smoke check isn't
 * dominated by noise either.
 */
function adaptiveSampleIntervalMs(plan: StressPlan): number {
  const finalPhase = plan.phases[plan.phases.length - 1];
  const targetRpm = finalPhase?.targetRpm ?? 0;
  if (targetRpm <= 0) return 500;
  return Math.min(2_000, Math.max(250, Math.round((5 * 60_000) / targetRpm)));
}

function computePhaseRecordCount(phase: StressPhase): number {
  if (phase.totalJobs !== undefined) return phase.totalJobs;
  if (phase.durationMs !== undefined) {
    const effectiveRpm = phase.targetRpm > 0 ? phase.targetRpm : (phase.concurrency ?? 50) * 20;
    const seconds = phase.durationMs / 1_000;
    return Math.max(20, Math.ceil((effectiveRpm / 60) * seconds * 1.1));
  }
  throw new Error(`stress phase "${phase.name}" must specify totalJobs or durationMs`);
}

function mergeSignals(signals: readonly (AbortSignal | undefined)[]): AbortSignal {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  return present.length === 1 && present[0] !== undefined ? present[0] : AbortSignal.any(present);
}

/**
 * Keeps `InstagramWorkloadProfile.clipsMaxPages/clipsMaxAuthors` in lockstep
 * with `AppConfig.instagram`, which is what actually bounds the real
 * `InstagramScraper` instance `buildRunner` constructs. The plan's workload
 * is the source of truth for *scenario mix*; the config is the source of
 * truth for scraper *bounds*, and the two must agree or a `clips_deep` match
 * could land outside the real scraper's own search window.
 */
function normalizeWorkloadForConfig(workload: WorkloadProfile, config: AppConfig): WorkloadProfile {
  return {
    ...workload,
    instagram: {
      ...workload.instagram,
      clipsMaxPages: config.instagram.clipsMaxPages,
      clipsMaxAuthors: config.instagram.clipsMaxAuthors,
    },
  };
}
