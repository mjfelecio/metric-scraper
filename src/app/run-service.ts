import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { loadConfig, type AppConfig } from '../config/env.js';
import { type ThroughputSample } from '../core/metrics/throughput-timeline.js';
import { parseInput } from '../core/input/parse-input.js';
import { type Logger, nullLogger } from '../core/logging/logger.js';
import { ScrapeError } from '../core/models/errors.js';
import { isFatalInputIssue, type ParsedInput } from '../core/models/input.js';
import { type Platform } from '../core/models/platform.js';
import { type RunSummary } from '../core/models/run-summary.js';
import { type CycleSummary } from '../core/models/session-summary.js';
import { type JobCompletedEvent } from '../core/runner/types.js';
import { type MetricSnapshot } from '../core/models/snapshot.js';
import { JsonlFileSink } from '../infrastructure/output/jsonl-file-sink.js';
import { ProxyEventLog } from '../infrastructure/output/proxy-event-log.js';
import {
  resolveRunPaths,
  resolveSessionPaths,
  writeRunSummary,
} from '../infrastructure/output/run-paths.js';
import { createDefaultUrlNormalizerRegistry } from '../platforms/index.js';

import { buildRunner, createProxySupply } from './composition.js';
import { appendMetricPoint } from './metric-series.js';
import { runSession, type SessionProgress } from './scrape-session.js';
import {
  type RecentResultDto,
  type SessionScheduleDto,
  type RunDefaultsDto,
  type RunStateDto,
  type StartRunRequest,
} from './types.js';

const RECENT_RESULTS_LIMIT = 50;

/**
 * Runs are kept in memory only, so the map needs a ceiling. One-shot runs made
 * this academic; a continuous session that a user starts and restarts all
 * afternoon does not.
 */
const MAX_RETAINED_RUNS = 20;

/** Samples retained per run for the dashboard graph. */
const MAX_TIMELINE_SAMPLES = 2_000;

/** How often a one-shot run re-reads the proxy pool for the dashboard. */
const PROXY_SAMPLE_INTERVAL_MS = 1_000;

interface RunRecord {
  state: RunStateDto;
  abort: AbortController;
  outputPath: string | null;
  /**
   * Full sample history. `state.timeline` is a *window* onto this, filled per
   * request from the caller's cursor, so a 400ms poll does not re-ship ten
   * minutes of samples on every tick.
   */
  timeline: ThroughputSample[];
}

/**
 * Application-layer entry point for starting and observing runs.
 *
 * The CLI drives the runner directly; the web dashboard drives it through this
 * service, which owns run lifecycle and keeps a bounded view of progress in
 * memory. Both paths share the same composition root, parser and output layer,
 * so the dashboard is not a parallel implementation of anything.
 *
 * State lives in this process only. Persisting run state is out of scope for
 * v1 (no database), and the JSONL output on disk is the durable artifact.
 */
export class RunService {
  private readonly runs = new Map<string, RunRecord>();
  private readonly logger: Logger;
  private readonly config: AppConfig;

  constructor(options: { logger?: Logger | undefined; config?: AppConfig | undefined } = {}) {
    this.logger = options.logger ?? nullLogger;
    this.config = options.config ?? loadConfig();
  }

  defaults(): RunDefaultsDto {
    const proxiesConfigured = this.config.proxy.pool
      .split(/[\n,;]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0).length;

    return {
      concurrency: this.config.concurrency,
      targetRpm: this.config.targetRpm,
      maxAttempts: this.config.retry.maxAttempts,
      outputDir: this.config.outputDir,
      proxiesConfigured,
      sessionsConfigured: this.config.session.storePath !== null,
      platforms: ['tiktok', 'instagram'],
      scrapersImplemented: ['tiktok', 'instagram'],
      pollIntervalMs: this.config.pollIntervalMs,
    };
  }

  list(): RunStateDto[] {
    return [...this.runs.values()].map((record) => record.state);
  }

  /**
   * Current state of a run.
   *
   * `since` is a timeline cursor: pass the `timelineCursor` from the previous
   * response and only newer samples come back, so a long session stays cheap to
   * watch. Omit it to receive everything retained.
   */
  get(runId: string, since = 0): RunStateDto | undefined {
    const record = this.runs.get(runId);
    if (record === undefined) return undefined;

    const total = record.state.timelineCursor;
    const oldest = total - record.timeline.length;
    const offset = Math.max(0, Math.min(record.timeline.length, since - oldest));

    return { ...record.state, timeline: record.timeline.slice(offset) };
  }

  /** Session summary for a continuous run, if it has finished one. */
  sessionSummary(runId: string): RunStateDto['sessionSummary'] {
    return this.runs.get(runId)?.state.sessionSummary ?? null;
  }

  cancel(runId: string): boolean {
    const record = this.runs.get(runId);
    if (record === undefined) return false;
    const { state } = record.state;
    // `waiting` counts: stopping during the gap between cycles is the most
    // likely moment for an operator to hit the button.
    if (state !== 'running' && state !== 'preparing' && state !== 'waiting') return false;
    record.abort.abort(
      new ScrapeError({ code: 'cancelled', message: 'run cancelled by operator' }),
    );
    return true;
  }

  /** Reads back the JSONL a run produced, for download/inspection. */
  async readOutput(runId: string): Promise<string> {
    const record = this.runs.get(runId);
    if (record === undefined) {
      throw new ScrapeError({ code: 'config_error', message: `unknown run "${runId}"` });
    }
    if (record.outputPath === null) {
      throw new ScrapeError({ code: 'output_error', message: 'this run produced no output file' });
    }
    try {
      return await readFile(record.outputPath, 'utf8');
    } catch (error) {
      throw new ScrapeError({
        code: 'output_error',
        message: `cannot read "${record.outputPath}": ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
      });
    }
  }

  /**
   * Validates input, starts the run in the background and returns immediately.
   * Progress is polled through {@link get}.
   */
  start(request: StartRunRequest): RunStateDto {
    const runId = randomUUID();
    const abort = new AbortController();

    const continuous = request.continuous === true;
    const schedule = continuous ? (request.schedule ?? this.defaultSchedule()) : null;

    const record: RunRecord = {
      abort,
      outputPath: null,
      timeline: [],
      state: {
        runId,
        state: 'preparing',
        platform: request.platform === 'auto' ? null : request.platform,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        progress: null,
        input: null,
        recentResults: [],
        summary: null,
        error: null,
        outputPath: null,
        hasOutput: false,
        proxies: null,
        continuous,
        schedule,
        cycle: null,
        timeline: [],
        timelineCursor: 0,
        cycles: [],
        metricSeries: [],
        sessionSummary: null,
        stalled: false,
      },
    };
    this.runs.set(runId, record);
    this.evictOldRuns();

    void (continuous
      ? this.executeSession(record, request, schedule as SessionScheduleDto)
      : this.execute(record, request));
    return record.state;
  }

  private defaultSchedule(): SessionScheduleDto {
    return { intervalMs: this.config.pollIntervalMs, durationMs: null, maxCycles: null };
  }

  /** Drops the oldest finished runs once the map is over its ceiling. */
  private evictOldRuns(): void {
    if (this.runs.size <= MAX_RETAINED_RUNS) return;
    for (const [id, record] of this.runs) {
      if (this.runs.size <= MAX_RETAINED_RUNS) break;
      const { state } = record.state;
      // Never evict something still moving, however old it is.
      if (state === 'completed' || state === 'failed') this.runs.delete(id);
    }
  }

  /**
   * Continuous variant of {@link execute}: same parsing, same output
   * conventions, but the batch repeats on a schedule and the dashboard watches
   * the session rather than a single run.
   */
  private async executeSession(
    record: RunRecord,
    request: StartRunRequest,
    schedule: SessionScheduleDto,
  ): Promise<void> {
    const { state } = record;

    try {
      const parsed = this.parseRequestInput(request);
      state.input = {
        candidates: parsed.totalCandidates,
        accepted: parsed.records.length,
        rejected: parsed.issues.length,
        issues: parsed.issues,
      };

      const fatal = parsed.issues.find(isFatalInputIssue);
      if (fatal !== undefined) {
        throw new ScrapeError({ code: 'invalid_url', message: fatal.message });
      }
      if (parsed.records.length === 0) {
        throw new ScrapeError({
          code: 'invalid_url',
          message: 'no usable URLs in the supplied input',
        });
      }

      const platform: Platform | null =
        request.platform === 'auto' ? inferPlatform(parsed) : request.platform;
      const paths = resolveSessionPaths({
        outputDir: this.config.outputDir,
        platform,
        startedAt: new Date(),
      });

      record.outputPath = paths.snapshots;
      state.outputPath = paths.snapshots;
      state.platform = platform;
      state.state = 'running';

      // The metric time series is a single-video view by construction: with two
      // URLs in the batch there is no one series to plot. Gating here means a
      // multi-URL session never accumulates or ships a byte of it.
      const trackMetrics = parsed.records.length === 1;
      // Held between the result landing and its cycle ending, so the point is
      // emitted by cycle completion rather than by the result itself.
      let pendingSnapshot: MetricSnapshot | null = null;

      const summary = await runSession({
        sessionId: state.runId,
        records: parsed.records,
        platform,
        counts: {
          candidates: parsed.totalCandidates,
          accepted: parsed.records.length,
          rejected: parsed.issues.length,
        },
        config: this.config,
        logger: this.logger,
        overrides: { concurrency: request.concurrency, targetRpm: request.targetRpm },
        schedule,
        paths,
        signal: record.abort.signal,
        maxSamples: MAX_TIMELINE_SAMPLES,
        onSample: (sample) => {
          record.timeline.push(sample);
          if (record.timeline.length > MAX_TIMELINE_SAMPLES) {
            record.timeline.splice(0, record.timeline.length - MAX_TIMELINE_SAMPLES);
          }
          state.timelineCursor += 1;
        },
        onProgress: (progress: SessionProgress) => {
          state.state = progress.state === 'waiting' ? 'waiting' : 'running';
          state.stalled = progress.stalled;
          state.proxies = progress.proxies.configured === 0 ? null : progress.proxies;
          state.cycle = {
            current: progress.cycle,
            completed: progress.cyclesCompleted,
            planned: progress.plannedCycles,
            nextStartsAt:
              progress.nextCycleAt === null ? null : new Date(progress.nextCycleAt).toISOString(),
          };
          // Reuse the one-shot progress shape so the existing stat cards and
          // progress bar keep working without a second code path.
          state.progress = {
            total: progress.total,
            processed: progress.processed,
            successful: progress.successes,
            failed: progress.failures,
            inFlight: progress.inFlight,
            queued: 0,
            elapsedMs: progress.elapsedMs,
            throughputPerMinute: progress.requestsPerMinute,
          };
        },
        onResult: (event): void => {
          this.pushRecentResult(state, event);
          if (trackMetrics) pendingSnapshot = event.snapshot;
        },
        onCycleEnd: (cycle: CycleSummary) => {
          state.cycles.push(cycle);
          if (cycle.summary !== null) state.summary = cycle.summary;
          if (trackMetrics) {
            appendMetricPoint(state.metricSeries, cycle, pendingSnapshot);
            // Cleared so the next cycle cannot re-emit this cycle's snapshot:
            // exactly one point per completed cycle, never a duplicate.
            pendingSnapshot = null;
          }
        },
      });

      state.sessionSummary = summary;
      state.hasOutput = summary.output.rows_written > 0;
      state.finishedAt = new Date().toISOString();
      state.cycle = {
        current: summary.cycles.started,
        completed: summary.cycles.completed,
        planned: schedule.maxCycles,
        nextStartsAt: null,
      };

      if (summary.schedule.stop_reason === 'fatal') {
        state.state = 'failed';
        state.error = { code: 'output_error', message: 'session stopped: output was unwritable' };
        return;
      }

      // Cancelling is a normal way to end a session — the cycle in flight
      // finished and every row it produced was kept — so it completes rather
      // than fails, and the reason is surfaced through the summary instead of
      // the error panel.
      state.state = 'completed';
    } catch (error) {
      const scrapeError = ScrapeError.from(error);
      state.state = 'failed';
      state.error = { code: scrapeError.code, message: scrapeError.message };
      state.finishedAt = new Date().toISOString();
      this.logger.error(
        { run_id: state.runId, error_code: scrapeError.code, message: scrapeError.message },
        'session failed',
      );
    }
  }

  private async execute(record: RunRecord, request: StartRunRequest): Promise<void> {
    const { state } = record;

    try {
      const parsed = this.parseRequestInput(request);
      state.input = {
        candidates: parsed.totalCandidates,
        accepted: parsed.records.length,
        rejected: parsed.issues.length,
        issues: parsed.issues,
      };

      const fatal = parsed.issues.find(isFatalInputIssue);
      if (fatal !== undefined) {
        throw new ScrapeError({ code: 'invalid_url', message: fatal.message });
      }
      if (parsed.records.length === 0) {
        throw new ScrapeError({
          code: 'invalid_url',
          message: 'no usable URLs in the supplied input',
        });
      }

      const platform: Platform | null =
        request.platform === 'auto' ? inferPlatform(parsed) : request.platform;
      const startedAt = new Date();
      const paths = resolveRunPaths({
        outputDir: this.config.outputDir,
        platform,
        startedAt,
      });

      const sink = new JsonlFileSink({ filePath: paths.snapshots });
      record.outputPath = paths.snapshots;
      state.outputPath = paths.snapshots;
      state.platform = platform;

      const proxyEvents = new ProxyEventLog({
        filePath: paths.proxyEvents,
        context: { run_id: state.runId },
        logger: this.logger,
      });
      const proxySupply = createProxySupply(
        this.config,
        this.logger,
        (event) => {
          proxyEvents.record(event);
        },
        request.concurrency,
      );
      await proxySupply.source?.start();

      const built = await buildRunner({
        config: this.config,
        logger: this.logger,
        sink,
        overrides: { concurrency: request.concurrency, targetRpm: request.targetRpm },
        proxyPool: proxySupply.pool,
      });

      state.state = 'running';

      // Sampled on a clock rather than per result: `getStats` is O(proxies) and
      // a one-shot run can finish hundreds of jobs a second, which would turn a
      // display concern into a per-job cost.
      let proxiesSampledAt = 0;
      const sampleProxies = (): void => {
        const at = Date.now();
        if (at - proxiesSampledAt < PROXY_SAMPLE_INTERVAL_MS) return;
        proxiesSampledAt = at;
        const stats = built.proxyPool.getStats();
        state.proxies = stats.configured === 0 ? null : stats;
      };
      sampleProxies();

      const result = await built.runner.run(parsed.records, {
        runId: state.runId,
        platform,
        signal: record.abort.signal,
        summaryPath: paths.summary,
        counts: {
          candidates: parsed.totalCandidates,
          accepted: parsed.records.length,
          rejected: parsed.issues.length,
        },
        onProgress: (progress) => {
          state.progress = progress;
          sampleProxies();
        },
        onResult: (event) => {
          this.pushRecentResult(state, event);
        },
      });

      proxiesSampledAt = 0;
      sampleProxies();
      proxySupply.source?.stop();
      await proxyEvents.close();
      await this.persistSummary(paths.summary, result.summary);

      state.summary = result.summary;
      state.hasOutput = result.summary.output.rows_written > 0;
      state.finishedAt = new Date().toISOString();

      if (result.fatalError !== null) {
        state.state = 'failed';
        state.error = { code: result.fatalError.code, message: result.fatalError.message };
        return;
      }

      state.state = record.abort.signal.aborted ? 'failed' : 'completed';
      if (record.abort.signal.aborted) {
        state.error = { code: 'cancelled', message: 'run was cancelled' };
      }
    } catch (error) {
      const scrapeError = ScrapeError.from(error);
      state.state = 'failed';
      state.error = { code: scrapeError.code, message: scrapeError.message };
      state.finishedAt = new Date().toISOString();
      this.logger.error(
        { run_id: state.runId, error_code: scrapeError.code, message: scrapeError.message },
        'run failed',
      );
    }
  }

  /**
   * Records one finished URL for the dashboard's results table.
   *
   * Newest first and capped: this is a live window, not a log — the JSONL on
   * disk is the complete record. Shared by both the one-shot and the continuous
   * path so a session's results table cannot drift from a run's.
   */
  private pushRecentResult(state: RunStateDto, event: JobCompletedEvent): void {
    const entry: RecentResultDto = {
      url: event.snapshot.url,
      platform: event.snapshot.platform,
      status: event.snapshot.status,
      latencyMs: event.snapshot.latency_ms,
      error: event.snapshot.error,
      scrapedAt: event.snapshot.scraped_at,
      attempts: event.attempts,
    };
    state.recentResults.unshift(entry);
    if (state.recentResults.length > RECENT_RESULTS_LIMIT) {
      state.recentResults.length = RECENT_RESULTS_LIMIT;
    }
  }

  private parseRequestInput(request: StartRunRequest): ParsedInput {
    return parseInput(request.input, {
      registry: createDefaultUrlNormalizerRegistry(),
      format: request.format,
      expectedPlatform: request.platform === 'auto' ? null : request.platform,
    });
  }

  private async persistSummary(path: string, summary: RunSummary): Promise<void> {
    try {
      await writeRunSummary(path, summary);
    } catch (error) {
      // A missing summary file must not discard a completed run's rows.
      this.logger.warn(
        { path, message: error instanceof Error ? error.message : String(error) },
        'could not write run summary',
      );
    }
  }
}

function inferPlatform(parsed: ParsedInput): Platform | null {
  const first = parsed.records[0];
  if (first === undefined) return null;
  return parsed.records.every((record) => record.platform === first.platform)
    ? first.platform
    : null;
}
