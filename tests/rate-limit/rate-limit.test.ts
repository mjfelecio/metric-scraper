import { describe, expect, it, vi } from 'vitest';

import { PQueueTaskQueue } from '../../src/core/concurrency/task-queue.js';
import { rpmToQueuePacing, TokenBucketRateLimiter } from '../../src/core/rate-limit/rate-limit.js';

describe('rpmToQueuePacing', () => {
  it('uniformly spaces jobs without rounding above the target', () => {
    expect(rpmToQueuePacing(500)).toEqual({ intervalMs: 120, intervalCap: 1 });
    expect(rpmToQueuePacing(60)).toEqual({ intervalMs: 1_000, intervalCap: 1 });
    expect(rpmToQueuePacing(6_000)).toEqual({ intervalMs: 10, intervalCap: 1 });
    expect(rpmToQueuePacing(15)).toEqual({ intervalMs: 4_000, intervalCap: 1 });
  });

  it('supports targets below one job per second', () => {
    expect(rpmToQueuePacing(1)).toEqual({ intervalMs: 60_000, intervalCap: 1 });
  });

  it('treats 0 and negatives as unpaced', () => {
    expect(rpmToQueuePacing(0).intervalCap).toBe(Number.POSITIVE_INFINITY);
    expect(rpmToQueuePacing(-5).intervalCap).toBe(Number.POSITIVE_INFINITY);
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

  it('starts paced jobs at the configured uniform interval', async () => {
    vi.useFakeTimers();
    try {
      const queue = new PQueueTaskQueue({ concurrency: 3, targetRpm: 120 });
      const starts: number[] = [];
      const jobs = Array.from({ length: 3 }, () =>
        queue.add(() => {
          starts.push(Date.now());
          return Promise.resolve();
        }),
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(starts).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(499);
      expect(starts).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(starts).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(500);
      expect(starts).toHaveLength(3);
      await Promise.all(jobs);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects when the queue is full', async () => {
    const queue = new PQueueTaskQueue({ concurrency: 1, maxQueueSize: 1 });
    const slow = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

    const running = queue.add(slow);
    const queued = queue.add(slow);
    await expect(queue.add(slow)).rejects.toThrow(/queue is full/);

    await Promise.all([running, queued]);
  });

  it('rejects an invalid concurrency', () => {
    expect(() => new PQueueTaskQueue({ concurrency: 0 })).toThrow(RangeError);
  });
});
