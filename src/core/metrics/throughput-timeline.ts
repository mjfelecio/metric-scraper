/**
 * Time series of achieved throughput across a session.
 *
 * `MetricsCollector.throughputPerMinute` is a *cumulative* average
 * (`totalRequests / elapsedMs`), which converges to a flat line and hides
 * exactly the dips a soak test exists to find. Everything here is derived from
 * the delta between consecutive samples instead, so a stall shows up as a
 * trough rather than a gentle downward drift.
 *
 * Samples are taken on a fixed cadence rather than per completed request, so an
 * idle gap between cycles is recorded as a real stretch of zero rather than a
 * hole in the data.
 *
 * The buffer is bounded: a ten-minute session at one-second buckets is 600
 * samples, but an overnight poll would otherwise grow without limit.
 */

export interface TimelineCounts {
  /** Cumulative completed work items for the whole session. Excludes retries. */
  completed: number;
  successes: number;
  failures: number;
  /** Cumulative retry attempts. Tracked so it can be shown *apart* from throughput. */
  retries: number;
  inFlight: number;
  /** Cycle in progress when the sample was taken; `0` between cycles. */
  cycle: number;
  /** Cumulative wire bytes for the run so far. */
  bytes: number;
}

export interface ThroughputSample {
  /** Milliseconds since the session began. */
  tMs: number;
  at: string;
  cycle: number;
  completed: number;
  successes: number;
  failures: number;
  retries: number;
  inFlight: number;
  /** Instantaneous rate over the window since the previous sample. */
  requestsPerMinute: number;
  successesPerMinute: number;
  failuresPerMinute: number;
  /** Kept separate from `requestsPerMinute` so retries can never inflate throughput. */
  retriesPerMinute: number;
  /** Cumulative wire bytes at this sample. */
  bytes: number;
  /** Wire bytes over the window since the previous sample, per minute. */
  bytesPerMinute: number;
}

export interface SustainedWindow {
  windowMs: number;
  fromMs: number;
  toMs: number;
}

export interface ThroughputTimelineOptions {
  /** Wall-clock origin of the session. */
  startedAtMs: number;
  /** Oldest samples are dropped past this. */
  maxSamples?: number | undefined;
  now?: (() => number) | undefined;
}

const DEFAULT_MAX_SAMPLES = 2_000;

export class ThroughputTimeline {
  private readonly buffer: ThroughputSample[] = [];
  private readonly maxSamples: number;
  private readonly startedAtMs: number;
  private readonly now: () => number;

  /** Total samples ever recorded, including evicted ones — the client's cursor. */
  private produced = 0;

  private lastAtMs: number;
  private lastCounts: TimelineCounts = {
    completed: 0,
    successes: 0,
    failures: 0,
    retries: 0,
    inFlight: 0,
    cycle: 0,
    bytes: 0,
  };

  constructor(options: ThroughputTimelineOptions) {
    this.startedAtMs = options.startedAtMs;
    this.maxSamples = Math.max(1, options.maxSamples ?? DEFAULT_MAX_SAMPLES);
    this.now = options.now ?? ((): number => Date.now());
    this.lastAtMs = options.startedAtMs;
  }

  /** Total samples ever produced. Survives eviction, so clients can page with it. */
  get cursor(): number {
    return this.produced;
  }

  record(counts: TimelineCounts): ThroughputSample | null {
    const atMs = this.now();
    const deltaMs = atMs - this.lastAtMs;

    // Two samples in the same millisecond would divide by zero and, worse,
    // report an infinite rate. Skipping is safe: the next sample covers the
    // whole window anyway.
    if (deltaMs <= 0) return null;

    // Every input is cumulative and monotonic; a negative delta means that
    // upstream invariant already failed, so no rate should expose the dip.
    const perMinute = (delta: number): number => Math.max(0, (delta / deltaMs) * 60_000);

    const sample: ThroughputSample = {
      tMs: Math.max(0, atMs - this.startedAtMs),
      at: new Date(atMs).toISOString(),
      cycle: counts.cycle,
      completed: counts.completed,
      successes: counts.successes,
      failures: counts.failures,
      retries: counts.retries,
      inFlight: counts.inFlight,
      requestsPerMinute: perMinute(counts.completed - this.lastCounts.completed),
      successesPerMinute: perMinute(counts.successes - this.lastCounts.successes),
      failuresPerMinute: perMinute(counts.failures - this.lastCounts.failures),
      retriesPerMinute: perMinute(counts.retries - this.lastCounts.retries),
      bytes: counts.bytes,
      bytesPerMinute: perMinute(counts.bytes - this.lastCounts.bytes),
    };

    this.lastAtMs = atMs;
    this.lastCounts = { ...counts };

    this.buffer.push(sample);
    this.produced += 1;
    if (this.buffer.length > this.maxSamples) {
      this.buffer.splice(0, this.buffer.length - this.maxSamples);
    }

    return sample;
  }

  samples(): readonly ThroughputSample[] {
    return this.buffer;
  }

  /** Samples produced at or after `cursor`, for incremental polling. */
  since(cursor: number): readonly ThroughputSample[] {
    const oldest = this.produced - this.buffer.length;
    const offset = Math.max(0, cursor - oldest);
    return offset >= this.buffer.length ? [] : this.buffer.slice(offset);
  }

  peakRequestsPerMinute(): number {
    return this.buffer.reduce((peak, sample) => Math.max(peak, sample.requestsPerMinute), 0);
  }

  /**
   * Longest contiguous stretch at or above `targetRpm`.
   *
   * This is the throughput requirement expressed as a number: "sustained 500
   * rpm for ten minutes" stops being an eyeballing exercise and becomes a field
   * in the session summary.
   */
  sustained(targetRpm: number): SustainedWindow {
    const best: SustainedWindow = { windowMs: 0, fromMs: 0, toMs: 0 };
    if (targetRpm <= 0) return best;

    let runStartMs: number | null = null;
    let previousMs = 0;

    for (const sample of this.buffer) {
      if (sample.requestsPerMinute >= targetRpm) {
        // A sample's rate describes the window *ending* at it, so the stretch
        // starts where the previous sample left off.
        runStartMs ??= previousMs;
        const windowMs = sample.tMs - runStartMs;
        if (windowMs > best.windowMs) {
          best.windowMs = windowMs;
          best.fromMs = runStartMs;
          best.toMs = sample.tMs;
        }
      } else {
        runStartMs = null;
      }
      previousMs = sample.tMs;
    }

    return best;
  }
}
