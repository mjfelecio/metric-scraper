import {
  type InputReportDto,
  type RecentResultDto,
  type RunDefaultsDto,
  type RunErrorDto,
  type RunState,
} from '../app/types.js';
import { type InputFormat } from '../core/models/input.js';
import { type Platform } from '../core/models/platform.js';
import { type RunSummary } from '../core/models/run-summary.js';
import { type RunProgress } from '../core/runner/types.js';

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

  runId: string | null;
  progress: RunProgress | null;
  input: InputReportDto | null;
  recentResults: RecentResultDto[];
  summary: RunSummary | null;
  error: RunErrorDto | null;
  hasOutput: boolean;
  defaults: RunDefaultsDto | null;
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

    runId: null,
    progress: null,
    input: null,
    recentResults: [],
    summary: null,
    error: null,
    hasOutput: false,
    defaults: null,
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
  return status === 'preparing' || status === 'running';
}
