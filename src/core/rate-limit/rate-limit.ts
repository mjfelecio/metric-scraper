/**
 * Rate limiting for the whole process.
 *
 * Two pieces live here:
 *
 * 1. `rpmToQueuePacing` — converts a target requests-per-minute into the
 *    interval window the task queue enforces. This is what actually paces a run.
 * 2. `TokenBucketRateLimiter` — a standalone limiter for cases where a queue
 *    is not involved (e.g. a future per-proxy or per-host budget).
 */

export interface QueuePacing {
  /** Length of the pacing window in milliseconds. */
  intervalMs: number;
  /** Maximum jobs started per window. `Infinity` means unpaced. */
  intervalCap: number;
}

/**
 * Spreads the budget over one-second windows rather than one-minute windows,
 * so 500 rpm means a steady ~9/sec instead of a 500-request burst followed by
 * 59 seconds of silence.
 */
export function rpmToQueuePacing(targetRpm: number, windowMs = 1_000): QueuePacing {
  if (!Number.isFinite(targetRpm) || targetRpm <= 0) {
    return { intervalMs: windowMs, intervalCap: Number.POSITIVE_INFINITY };
  }
  const perWindow = (targetRpm * windowMs) / 60_000;
  return { intervalMs: windowMs, intervalCap: Math.max(1, Math.ceil(perWindow)) };
}

export interface RateLimiter {
  /** Resolves once the caller is allowed to proceed. */
  acquire(signal?: AbortSignal): Promise<void>;
}

export const unlimitedRateLimiter: RateLimiter = {
  acquire: () => Promise.resolve(),
};

export interface TokenBucketOptions {
  /** Tokens added per second. */
  refillPerSecond: number;
  /** Maximum tokens that can accumulate — the burst size. */
  capacity: number;
  now?: (() => number) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

export class TokenBucketRateLimiter implements RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly refillPerSecond: number;
  private readonly capacity: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private chain: Promise<void> = Promise.resolve();

  constructor(options: TokenBucketOptions) {
    if (options.refillPerSecond <= 0) throw new RangeError('refillPerSecond must be > 0');
    if (options.capacity <= 0) throw new RangeError('capacity must be > 0');
    this.refillPerSecond = options.refillPerSecond;
    this.capacity = options.capacity;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.tokens = options.capacity;
    this.lastRefill = this.now();
  }

  /** Current token count, after applying elapsed-time refill. Exposed for tests. */
  availableTokens(): number {
    this.refill();
    return this.tokens;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    // Serialize waiters so tokens are handed out in arrival order.
    const previous = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    try {
      for (;;) {
        if (signal?.aborted === true) {
          throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
        }
        this.refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return;
        }
        const deficit = 1 - this.tokens;
        await this.sleep(Math.ceil((deficit / this.refillPerSecond) * 1000));
      }
    } finally {
      release();
    }
  }

  private refill(): void {
    const now = this.now();
    const elapsedMs = Math.max(0, now - this.lastRefill);
    if (elapsedMs === 0) return;
    this.lastRefill = now;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsedMs / 1000) * this.refillPerSecond);
  }
}
