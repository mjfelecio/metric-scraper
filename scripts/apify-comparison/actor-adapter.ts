import { type BenchmarkMetrics, type BenchmarkTarget } from './types.js';

/**
 * The seam between "which Actor are we testing" and "how do we compare".
 *
 * Actor input schemas and output shapes are vendor-specific and change without
 * notice; the comparison, join, delta and report code must not know any of it.
 * A second Actor is then a second implementation of this interface and nothing
 * else — which is the whole reason this experiment is worth building rather
 * than eyeballing one dataset by hand.
 */
export interface ActorAdapter {
  /** Human-readable id, for the report. */
  readonly actorId: string;
  /** The smallest input that answers the question, with every paid add-on off. */
  buildInput(targets: readonly BenchmarkTarget[]): Record<string, unknown>;
  /** The input feature flags worth recording so the run can be reproduced. */
  describeFeatureFlags(input: Record<string, unknown>): Record<string, unknown>;
  /** One dataset row into benchmark shape, or a reason it could not be read. */
  normalizeRow(row: unknown): NormalizedRow;
}

export type NormalizedRow = NormalizedRowOk | NormalizedRowError;

export interface NormalizedRowOk {
  readonly kind: 'ok';
  /** `null` when the row carries no recoverable TikTok id — it cannot be joined. */
  readonly videoId: string | null;
  readonly url: string | null;
  readonly metrics: BenchmarkMetrics;
}

export interface NormalizedRowError {
  readonly kind: 'error';
  readonly videoId: string | null;
  readonly url: string | null;
  /** Whatever the Actor said went wrong, already stringified. */
  readonly message: string;
}
