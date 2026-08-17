import { type InputFormat, type InputIssue } from '../core/models/input.js';
import { type Platform } from '../core/models/platform.js';
import { type RunSummary } from '../core/models/run-summary.js';
import { type ScrapeStatus } from '../core/models/status.js';
import { type RunProgress } from '../core/runner/types.js';

/**
 * Transport types shared between the Node application layer and the browser
 * dashboard. Types only — this module must stay free of Node imports so the
 * web bundle can import it.
 */

export const RUN_STATES = ['idle', 'preparing', 'running', 'completed', 'failed'] as const;
export type RunState = (typeof RUN_STATES)[number];

export interface StartRunRequest {
  /** `'auto'` accepts a mixed batch and routes by URL host. */
  platform: Platform | 'auto';
  /** Raw input text: newline-delimited URLs or a JSON array. */
  input: string;
  format: InputFormat | 'auto';
  concurrency: number;
  targetRpm: number;
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
}
