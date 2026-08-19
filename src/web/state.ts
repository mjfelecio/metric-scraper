import {
  type CycleProgressDto,
  type InputReportDto,
  type MetricPointDto,
  type RecentResultDto,
  type RunDefaultsDto,
  type RunErrorDto,
  type RunState,
  type SessionScheduleDto,
} from '../app/types.js';
import { type InputFormat } from '../core/models/input.js';
import { type Platform } from '../core/models/platform.js';
import { type RunSummary } from '../core/models/run-summary.js';
import { type ThroughputSample } from '../core/metrics/throughput-timeline.js';
import { type CycleSummary, type SessionSummary } from '../core/models/session-summary.js';
import { type RunProgress } from '../core/runner/types.js';
import { type MetricKey } from './metric-format.js';
import { type ProxyPoolStats } from '../core/scraper/pool-ports.js';

export type InputMethod = 'paste' | 'file';

/**
 * The single mutable object the UI renders from.
 *
 * No framework: state changes go through `Store.update`, which notifies
 * subscribers, and the render functions read the whole state each time. At this
 * size that is simpler and easier to follow than any reactive layer.
 */
export interface AppState {
  status: RunState;
  platform: Platform | 'auto';
  inputMethod: InputMethod;
  inputText: string;
  format: InputFormat | 'auto';
  fileName: string | null;
  concurrency: number;
  targetRpm: number;

  /** Continuous-mode form fields. Kept as typed text so `15m` survives a round trip. */
  continuous: boolean;
  interval: string;
  duration: string;
  maxCycles: string;

  runId: string | null;
  progress: RunProgress | null;
  input: InputReportDto | null;
  recentResults: RecentResultDto[];
  summary: RunSummary | null;
  error: RunErrorDto | null;
  hasOutput: boolean;
  defaults: RunDefaultsDto | null;
  /** Live proxy pool state; `null` when no proxies are configured. */
  proxies: ProxyPoolStats | null;

  schedule: SessionScheduleDto | null;
  cycle: CycleProgressDto | null;
  /** Accumulated client-side from the poll cursor, never re-fetched wholesale. */
  timeline: ThroughputSample[];
  timelineCursor: number;
  cycles: CycleSummary[];
  /** Live metric history; only ever non-empty for a single-URL session. */
  metricSeries: MetricPointDto[];
  /** Which series the metric chart is showing. Purely a view concern. */
  metric: MetricKey;
  sessionSummary: SessionSummary | null;
  stalled: boolean;
}

export function createInitialState(): AppState {
  return {
    status: 'idle',
    platform: 'auto',
    inputMethod: 'paste',
    inputText: '',
    format: 'auto',
    fileName: null,
    concurrency: 10,
    targetRpm: 500,

    continuous: false,
    interval: '15m',
    duration: '',
    maxCycles: '',

    runId: null,
    progress: null,
    input: null,
    recentResults: [],
    summary: null,
    error: null,
    hasOutput: false,
    defaults: null,
    proxies: null,

    schedule: null,
    cycle: null,
    timeline: [],
    timelineCursor: 0,
    cycles: [],
    metricSeries: [],
    metric: 'views',
    sessionSummary: null,
    stalled: false,
  };
}

export type Listener = (state: AppState) => void;

export class Store {
  private state: AppState = createInitialState();
  private readonly listeners = new Set<Listener>();

  getState(): AppState {
    return this.state;
  }

  update(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }
}

/** Controls are locked while a run owns the process. */
export function isRunActive(status: RunState): boolean {
  // `waiting` is active too: a session between cycles is still running, and
  // letting the form be edited mid-session would silently do nothing.
  return status === 'preparing' || status === 'running' || status === 'waiting';
}
