import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { loadConfig, type AppConfig } from '../config/env.js';
import { parseInput } from '../core/input/parse-input.js';
import { type Logger, nullLogger } from '../core/logging/logger.js';
import { ScrapeError } from '../core/models/errors.js';
import { isFatalInputIssue, type ParsedInput } from '../core/models/input.js';
import { type Platform } from '../core/models/platform.js';
import { type RunSummary } from '../core/models/run-summary.js';
import { JsonlFileSink } from '../infrastructure/output/jsonl-file-sink.js';
import { resolveRunPaths, writeRunSummary } from '../infrastructure/output/run-paths.js';
import { createDefaultUrlNormalizerRegistry } from '../platforms/index.js';

import { buildRunner } from './composition.js';
import {
  type RecentResultDto,
  type RunDefaultsDto,
  type RunStateDto,
  type StartRunRequest,
} from './types.js';

const RECENT_RESULTS_LIMIT = 50;

interface RunRecord {
  state: RunStateDto;
  abort: AbortController;
  outputPath: string | null;
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
      // Nothing is implemented yet; the dashboard says so rather than implying
      // a run that returns only failures is a bug.
      scrapersImplemented: [],
    };
  }

  list(): RunStateDto[] {
    return [...this.runs.values()].map((record) => record.state);
  }

  get(runId: string): RunStateDto | undefined {
    return this.runs.get(runId)?.state;
  }

  cancel(runId: string): boolean {
    const record = this.runs.get(runId);
    if (record === undefined) return false;
    if (record.state.state !== 'running' && record.state.state !== 'preparing') return false;
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

    const record: RunRecord = {
      abort,
      outputPath: null,
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
      },
    };
    this.runs.set(runId, record);

    void this.execute(record, request);
    return record.state;
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

      const built = await buildRunner({
        config: this.config,
        logger: this.logger,
        sink,
        overrides: { concurrency: request.concurrency, targetRpm: request.targetRpm },
      });

      state.state = 'running';

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
        },
        onResult: (event) => {
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
        },
      });

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
