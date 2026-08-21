import { describe, expect, it } from 'vitest';

import { PQueueTaskQueue } from '../../src/core/concurrency/task-queue.js';
import { ScrapeError } from '../../src/core/models/errors.js';
import {
  createRateLimiter,
  TokenBucketRateLimiter,
  unlimitedRateLimiter,
} from '../../src/core/rate-limit/rate-limit.js';

describe('createRateLimiter', () => {
  it('treats 0 and negatives as unlimited', () => {
    expect(createRateLimiter({ rpm: 0 })).toBe(unlimitedRateLimiter);
    expect(createRateLimiter({ rpm: -5 })).toBe(unlimitedRateLimiter);
  });

  it('defaults burst to one second of budget so a small batch is not trickled out', async () => {
    // 600 rpm = 10/s, so ten units must be spendable immediately.
    const limiter = createRateLimiter({
      rpm: 600,
      now: () => 0,
      sleep: () => Promise.reject(new Error('should not need to sleep')),
    });

    for (let i = 0; i < 10; i += 1) {
      await limiter.acquire();
    }
  });

  it('paces beyond the burst at the configured rate', async () => {
    let now = 0;
    const slept: number[] = [];
    const limiter = createRateLimiter({
      rpm: 600, // 10 per second
      burst: 1,
      now: () => now,
      sleep: (ms) => {
        slept.push(ms);
        now += ms;
        return Promise.resolve();
      },
    });

    await limiter.acquire();
    await limiter.acquire();

    expect(slept).toEqual([100]);
  });
});

describe('TokenBucketRateLimiter', () => {
  it('serves from the initial burst without waiting', async () => {
    const limiter = new TokenBucketRateLimiter({
      refillPerSecond: 1,
      capacity: 3,
      now: () => 0,
      sleep: () => Promise.reject(new Error('should not need to sleep')),
    });

    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.availableTokens()).toBeCloseTo(0);
  });

  it('waits when the bucket is empty and refills over time', async () => {
    let now = 0;
    const slept: number[] = [];
    const limiter = new TokenBucketRateLimiter({
      refillPerSecond: 10,
      capacity: 1,
      now: () => now,
      sleep: (ms) => {
        slept.push(ms);
        now += ms;
        return Promise.resolve();
      },
    });

    await limiter.acquire();
    await limiter.acquire();

    expect(slept).toHaveLength(1);
    expect(slept[0]).toBe(100);
  });

  it('rejects nonsensical configuration', () => {
    expect(() => new TokenBucketRateLimiter({ refillPerSecond: 0, capacity: 1 })).toThrow(
      RangeError,
    );
    expect(() => new TokenBucketRateLimiter({ refillPerSecond: 1, capacity: 0 })).toThrow(
      RangeError,
    );
  });
});

describe('PQueueTaskQueue', () => {
  it('runs tasks and reports their results', async () => {
    const queue = new PQueueTaskQueue({ concurrency: 2 });
    const results = await Promise.all([
      queue.add(() => Promise.resolve(1)),
      queue.add(() => Promise.resolve(2)),
    ]);
    expect(results).toEqual([1, 2]);
  });

  it('caps in-flight tasks at the configured concurrency', async () => {
    const queue = new PQueueTaskQueue({ concurrency: 2 });
    let inFlight = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 8 }, () =>
        queue.add(async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
        }),
      ),
    );

    expect(peak).toBe(2);
  });

  it('reaches the configured concurrency rather than stopping at one', async () => {
    const queue = new PQueueTaskQueue({ concurrency: 10 });

    await Promise.all(
      Array.from({ length: 20 }, () =>
        queue.add(() => new Promise((resolve) => setTimeout(resolve, 10))),
      ),
    );

    expect(queue.stats().peakInFlight).toBe(10);
  });

  it('measures its own peak in-flight, so a report cannot claim capacity it never used', async () => {
    const queue = new PQueueTaskQueue({ concurrency: 4 });

    await Promise.all(
      Array.from({ length: 12 }, () =>
        queue.add(() => new Promise((resolve) => setTimeout(resolve, 5))),
      ),
    );

    const stats = queue.stats();
    expect(stats.peakInFlight).toBe(4);
    expect(stats.waitSamples).toHaveLength(12);
    expect(stats.peakQueueDepth).toBeGreaterThan(0);
  });

  it('makes the producer wait for room instead of rejecting the job', async () => {
    const queue = new PQueueTaskQueue({ concurrency: 1, maxQueueSize: 1 });
    const slow = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

    const running = queue.add(slow);
    const queued = queue.add(slow);

    // The queue is full; capacity must not resolve until the backlog drains.
    let released = false;
    const capacity = queue.awaitCapacity().then(() => {
      released = true;
    });
    expect(released).toBe(false);

    await capacity;
    expect(released).toBe(true);

    await Promise.all([running, queued]);
  });

  it('resolves capacity immediately when the queue is unbounded', async () => {
    const queue = new PQueueTaskQueue({ concurrency: 1, maxQueueSize: 0 });
    await expect(queue.awaitCapacity()).resolves.toBeUndefined();
  });

  it('does not park the producer forever once the run is aborted', async () => {
    const queue = new PQueueTaskQueue({ concurrency: 1, maxQueueSize: 1 });
    const slow = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));
    const running = queue.add(slow);
    const queued = queue.add(slow);

    const controller = new AbortController();
    controller.abort();
    await expect(queue.awaitCapacity(controller.signal)).resolves.toBeUndefined();

    await Promise.all([running, queued]);
  });

  it('rejects an invalid concurrency', () => {
    expect(() => new PQueueTaskQueue({ concurrency: 0 })).toThrow(RangeError);
  });
});

describe('concurrency and rate limiting together', () => {
  // The regression guard for the bug this design replaced: a rate limiter used
  // to be expressed as queue pacing, and an `intervalCap` of 1 meant one running
  // task blocked every other start. Configured concurrency 10 ran one job at a
  // time. Rate limiting must pace starts without capping how many overlap.
  it('still overlaps requests while the rate limiter is active', async () => {
    const queue = new PQueueTaskQueue({ concurrency: 10 });
    const limiter = createRateLimiter({ rpm: 60_000, burst: 10 });

    let inFlight = 0;
    let peak = 0;
    const jobs: Promise<void>[] = [];

    for (let i = 0; i < 30; i += 1) {
      await limiter.acquire();
      jobs.push(
        queue.add(async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 20));
          inFlight -= 1;
        }),
      );
    }

    await Promise.all(jobs);

    expect(peak).toBeGreaterThan(1);
    expect(peak).toBe(10);
  });
});

describe('TokenBucketRateLimiter maxWaitMs', () => {
  function limiterAt(now: () => number, sleep: (ms: number) => Promise<void>) {
    // 60 rpm = one token per second, capacity 1: the second acquire in a row
    // must wait a full second.
    return new TokenBucketRateLimiter({ refillPerSecond: 1, capacity: 1, now, sleep });
  }

  it('waits normally when the queue fits inside the budget', async () => {
    let now = 0;
    const limiter = limiterAt(
      () => now,
      (ms) => {
        now += ms;
        return Promise.resolve();
      },
    );

    await limiter.acquire(undefined, { maxWaitMs: 5_000 });
    await limiter.acquire(undefined, { maxWaitMs: 5_000 });
    expect(now).toBe(1_000);
  });

  it('rejects with a retryable throttled error rather than sleeping past the budget', async () => {
    let now = 0;
    const limiter = limiterAt(
      () => now,
      (ms) => {
        now += ms;
        return Promise.resolve();
      },
    );

    await limiter.acquire(undefined, { maxWaitMs: 500 });
    const error = await limiter.acquire(undefined, { maxWaitMs: 500 }).catch((e: unknown) => e);

    expect(ScrapeError.isScrapeError(error)).toBe(true);
    expect((error as ScrapeError).code).toBe('throttled');
    expect((error as ScrapeError).retryable).toBe(true);
    // Turned away before sleeping, not after: the clock never advanced.
    expect(now).toBe(0);
  });

  it('does not consume a token when it gives up', async () => {
    let now = 0;
    const limiter = limiterAt(
      () => now,
      (ms) => {
        now += ms;
        return Promise.resolve();
      },
    );

    await limiter.acquire(undefined, { maxWaitMs: 500 });
    await expect(limiter.acquire(undefined, { maxWaitMs: 500 })).rejects.toThrow();

    // A full second's refill buys exactly one token, which proves the rejected
    // call took nothing: otherwise the balance would be short.
    now = 1_000;
    expect(limiter.availableTokens()).toBeCloseTo(1, 5);
  });

  it('counts time spent queued behind earlier waiters, not just its own sleeping', async () => {
    let now = 0;
    const limiter = limiterAt(
      () => now,
      (ms) => {
        now += ms;
        return Promise.resolve();
      },
    );

    await limiter.acquire();
    // Two waiters enter together. The first sleeps a second and succeeds; the
    // second has by then already burned its whole budget queueing, which is the
    // wait that actually grows with concurrency.
    const first = limiter.acquire(undefined, { maxWaitMs: 1_500 });
    const second = limiter.acquire(undefined, { maxWaitMs: 1_500 });

    await expect(first).resolves.toBeUndefined();
    await expect(second).rejects.toMatchObject({ code: 'throttled' });
  });

  it('waits indefinitely when no budget is given', async () => {
    let now = 0;
    const limiter = limiterAt(
      () => now,
      (ms) => {
        now += ms;
        return Promise.resolve();
      },
    );

    await limiter.acquire();
    await limiter.acquire(undefined, { maxWaitMs: 0 });
    await limiter.acquire();
    expect(now).toBe(2_000);
  });
});
