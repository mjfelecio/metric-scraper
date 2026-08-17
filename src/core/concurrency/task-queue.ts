import PQueue from 'p-queue';

import { ScrapeError } from '../models/errors.js';
import { rpmToQueuePacing } from '../rate-limit/rate-limit.js';

/**
 * Concurrency port.
 *
 * A single-process queue is enough for the current target (~500 rpm), but the
 * runner only knows this interface — so swapping in a distributed queue later
 * means writing another implementation, not rewriting orchestration.
 */
export interface TaskQueue {
  add<T>(task: () => Promise<T>): Promise<T>;
  /** Resolves when every queued and running task has settled. */
  onIdle(): Promise<void>;
  /** Drops queued tasks that have not started. Running tasks are unaffected. */
  clear(): void;
  readonly size: number;
  readonly pending: number;
}

export interface TaskQueueOptions {
  concurrency: number;
  /** Requests per minute ceiling for the whole queue. `0` disables pacing. */
  targetRpm?: number | undefined;
  /** Reject `add` beyond this many waiting tasks. `0` = unbounded. */
  maxQueueSize?: number | undefined;
}

export class PQueueTaskQueue implements TaskQueue {
  private readonly queue: PQueue;
  private readonly maxQueueSize: number;

  constructor(options: TaskQueueOptions) {
    if (options.concurrency < 1) {
      throw new RangeError('concurrency must be >= 1');
    }
    const pacing = rpmToQueuePacing(options.targetRpm ?? 0);
    this.maxQueueSize = options.maxQueueSize ?? 0;

    this.queue = new PQueue({
      concurrency: options.concurrency,
      ...(Number.isFinite(pacing.intervalCap)
        ? {
            interval: pacing.intervalMs,
            intervalCap: pacing.intervalCap,
            carryoverConcurrencyCount: true,
          }
        : {}),
    });
  }

  get size(): number {
    return this.queue.size;
  }

  get pending(): number {
    return this.queue.pending;
  }

  async add<T>(task: () => Promise<T>): Promise<T> {
    if (this.maxQueueSize > 0 && this.queue.size >= this.maxQueueSize) {
      throw new ScrapeError({
        code: 'config_error',
        message: `queue is full (${this.maxQueueSize} waiting tasks)`,
      });
    }
    // p-queue types the result as `T | void` to accommodate aborted tasks; we
    // never pass an abort signal to `add`, so the task always produces a value.
    return (await this.queue.add(task)) as T;
  }

  async onIdle(): Promise<void> {
    await this.queue.onIdle();
  }

  clear(): void {
    this.queue.clear();
  }
}
