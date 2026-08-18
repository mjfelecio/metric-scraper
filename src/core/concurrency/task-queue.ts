import PQueue from 'p-queue';

/**
 * Concurrency port.
 *
 * A single-process queue is enough for the current target (~500 rpm), but the
 * runner only knows this interface — so swapping in a distributed queue later
 * means writing another implementation, not rewriting orchestration.
 *
 * This queue limits **concurrency only**. Rate policy lives behind the
 * `RateLimiter` port and backpressure is `awaitCapacity`. Those three concerns
 * were previously collapsed into one p-queue configuration, which is how a
 * configured concurrency of 10 silently became an effective concurrency of 1:
 * an `intervalCap` of 1 combined with `carryoverConcurrencyCount` meant a
 * single running task consumed the whole interval budget, so no second task
 * could ever start. Keeping pacing out of this class makes that class of bug
 * unrepresentable.
 */
export interface TaskQueue {
  /** Resolves with the task's result. Producers must NOT await this inline. */
  add<T>(task: () => Promise<T>): Promise<T>;
  /**
   * Backpressure: resolves once the queue has room for another waiting task.
   * Producers await this *before* enqueueing, so a large input cannot
   * materialize as unbounded pending work.
   */
  awaitCapacity(signal?: AbortSignal): Promise<void>;
  /** Resolves when every queued and running task has settled. */
  onIdle(): Promise<void>;
  /** Drops queued tasks that have not started. Running tasks are unaffected. */
  clear(): void;
  readonly size: number;
  readonly pending: number;
  stats(): TaskQueueStats;
}

export interface TaskQueueStats {
  /** Highest number of tasks running at the same moment. The truth about concurrency. */
  peakInFlight: number;
  /** Highest number of tasks waiting to start. */
  peakQueueDepth: number;
  /** Per-task wait between being enqueued and starting, in ms. */
  waitSamples: readonly number[];
}

export interface TaskQueueOptions {
  concurrency: number;
  /** Max tasks waiting (not running) before producers are made to wait. `0` = unbounded. */
  maxQueueSize?: number | undefined;
  now?: (() => number) | undefined;
}

export class PQueueTaskQueue implements TaskQueue {
  private readonly queue: PQueue;
  private readonly maxQueueSize: number;
  private readonly now: () => number;

  private inFlight = 0;
  private peakInFlight = 0;
  private peakQueueDepth = 0;
  private readonly waitSamples: number[] = [];

  constructor(options: TaskQueueOptions) {
    if (options.concurrency < 1) {
      throw new RangeError('concurrency must be >= 1');
    }
    this.maxQueueSize = options.maxQueueSize ?? 0;
    this.now = options.now ?? (() => Date.now());

    // Concurrency and nothing else. No interval, no intervalCap, no carryover.
    this.queue = new PQueue({ concurrency: options.concurrency });
  }

  get size(): number {
    return this.queue.size;
  }

  get pending(): number {
    return this.queue.pending;
  }

  stats(): TaskQueueStats {
    return {
      peakInFlight: this.peakInFlight,
      peakQueueDepth: this.peakQueueDepth,
      waitSamples: this.waitSamples,
    };
  }

  async awaitCapacity(signal?: AbortSignal): Promise<void> {
    if (this.maxQueueSize <= 0) return;
    if (this.queue.size < this.maxQueueSize) return;
    if (signal?.aborted === true) return;

    if (signal === undefined) {
      await this.queue.onSizeLessThan(this.maxQueueSize);
      return;
    }

    // Never leave the producer parked on a queue that will not drain because
    // the run was cancelled.
    let onAbort!: () => void;
    const aborted = new Promise<void>((resolve) => {
      onAbort = resolve;
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([this.queue.onSizeLessThan(this.maxQueueSize), aborted]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  async add<T>(task: () => Promise<T>): Promise<T> {
    const enqueuedAt = this.now();
    if (this.queue.size + 1 > this.peakQueueDepth) {
      this.peakQueueDepth = this.queue.size + 1;
    }

    // p-queue types the result as `T | void` to accommodate aborted tasks; we
    // never pass an abort signal to `add`, so the task always produces a value.
    return (await this.queue.add(async () => {
      this.waitSamples.push(Math.max(0, this.now() - enqueuedAt));
      this.inFlight += 1;
      if (this.inFlight > this.peakInFlight) {
        this.peakInFlight = this.inFlight;
      }
      try {
        return await task();
      } finally {
        this.inFlight -= 1;
      }
    })) as T;
  }

  async onIdle(): Promise<void> {
    await this.queue.onIdle();
  }

  clear(): void {
    this.queue.clear();
  }
}
