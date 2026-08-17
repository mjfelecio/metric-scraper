import { type MetricSnapshot } from '../models/snapshot.js';

/** Emitted once per finished URL (success or failure). */
export interface JobCompletedEvent {
  snapshot: MetricSnapshot;
  /** Attempts used, including the first. */
  attempts: number;
  /** `attempts - 1`. Kept explicit because summaries report it separately. */
  retries: number;
  /** Credential-free proxy id used for the final attempt, if any. */
  proxyId: string | null;
}

/** Cheap, frequently emitted progress snapshot for CLI/UI display. */
export interface RunProgress {
  total: number;
  processed: number;
  successful: number;
  failed: number;
  inFlight: number;
  queued: number;
  elapsedMs: number;
  throughputPerMinute: number;
}

export interface RunCounts {
  candidates: number;
  accepted: number;
  rejected: number;
}
