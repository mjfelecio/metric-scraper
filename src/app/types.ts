import { type ThroughputSample } from '../core/metrics/throughput-timeline.js';
import { type InputFormat, type InputIssue } from '../core/models/input.js';
import { type Platform } from '../core/models/platform.js';
import { type RunSummary } from '../core/models/run-summary.js';
import { type CycleSummary, type SessionSummary } from '../core/models/session-summary.js';
import { type ScrapeStatus } from '../core/models/status.js';
import { type ProxyPoolStats } from '../core/scraper/pool-ports.js';
import { type RunProgress } from '../core/runner/types.js';

/**
 * Transport types shared between the Node application layer and the browser
 * dashboard. Types only — this module must stay free of Node imports so the
 * web bundle can import it.
 */

/**
 * `waiting` is the idle gap between cycles of a continuous session. Without
 * it a 15-minute poll interval makes a perfectly healthy dashboard look hung.
 */
export const RUN_STATES = [
  'idle',
  'preparing',
  'running',
  'waiting',
  'completed',
  'failed',
] as const;
export type RunState = (typeof RUN_STATES)[number];

export interface StartRunRequest {
  /** `'auto'` accepts a mixed batch and routes by URL host. */
  platform: Platform | 'auto';
  /** Raw input text: newline-delimited URLs or a JSON array. */
  input: string;
  format: InputFormat | 'auto';
  concurrency: number;
  targetRpm: number;
  /** Repeat the batch on a schedule instead of running it once. */
  continuous?: boolean | undefined;
  schedule?: SessionScheduleDto | undefined;
}

export interface SessionScheduleDto {
  /** Time between cycle starts. `0` = back-to-back. */
  intervalMs: number;
  /** Stop starting new cycles after this. `null` = unbounded. */
  durationMs: number | null;
  maxCycles: number | null;
}

export interface CycleProgressDto {
  current: number;
  completed: number;
  planned: number | null;
  /** ISO timestamp of the next scheduled cycle start; `null` when back-to-back. */
  nextStartsAt: string | null;
}

export interface RunErrorDto {
  code: string;
  message: string;
}

export interface RecentResultDto {
  url: string;
  platform: Platform;
  status: ScrapeStatus;
  latencyMs: number;
  error: string | null;
  scrapedAt: string;
  attempts: number;
}

export interface InputReportDto {
  candidates: number;
  accepted: number;
  rejected: number;
  issues: InputIssue[];
}

/**
 * One completed cycle's engagement metrics for a single-URL continuous session.
 *
 * Built from the `MetricSnapshot` the runner already produced — the same object
 * that was written to the JSONL — so the dashboard and the output file can never
 * disagree. Counts are the platform's exact integers: any abbreviation is a
 * presentation concern and happens in the browser.
 */
export interface MetricPointDto {
  /** 1-based, matching `CycleSummary.cycle`. */
  cycle: number;
  /** ISO timestamp of the scrape, falling back to when the cycle finished. */
  at: string;
  /** Drives the gap rendering: a non-`ok` cycle has null counts by definition. */
  status: ScrapeStatus;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
}

export interface RunStateDto {
  runId: string;
  state: RunState;
  platform: Platform | null;
  startedAt: string | null;
  finishedAt: string | null;
  progress: RunProgress | null;
  input: InputReportDto | null;
  recentResults: RecentResultDto[];
  summary: RunSummary | null;
  error: RunErrorDto | null;
  outputPath: string | null;
  /** True when the run wrote rows that can be downloaded. */
  hasOutput: boolean;
  /**
   * Live proxy pool state, sampled about once a second while the run is moving.
   *
   * Shipped on the existing run-state poll rather than through a route of its
   * own: it is O(proxies) and the dashboard is already asking for this object.
   * `null` when no proxies are configured.
   */
  proxies: ProxyPoolStats | null;

  /** Continuous-session fields. All inert for a one-shot run. */
  continuous: boolean;
  schedule: SessionScheduleDto | null;
  cycle: CycleProgressDto | null;
  /** Throughput samples newer than the requested cursor, oldest first. */
  timeline: ThroughputSample[];
  /** Total samples ever produced, so the client can ask for only what is new. */
  timelineCursor: number;
  cycles: CycleSummary[];
  /**
   * One point per completed cycle, oldest first.
   *
   * Only accumulated when the session's input parsed to exactly one URL; empty
   * for every other run, so a multi-URL session pays nothing for this.
   */
  metricSeries: MetricPointDto[];
  sessionSummary: SessionSummary | null;
  /** Work was in flight but nothing completed for an unreasonably long time. */
  stalled: boolean;
}

export interface RunDefaultsDto {
  concurrency: number;
  targetRpm: number;
  maxAttempts: number;
  outputDir: string;
  proxiesConfigured: number;
  sessionsConfigured: boolean;
  platforms: Platform[];
  /** Surfaced in the UI so the placeholder behaviour is never a surprise. */
  scrapersImplemented: Platform[];
  /** Default gap between cycle starts, from `SCRAPER_POLL_INTERVAL_MS`. */
  pollIntervalMs: number;
}
