/**
 * Rate limiting for the whole process.
 *
 * Rate is deliberately NOT expressed as task-queue pacing. Doing that couples
 * it to concurrency: the previous implementation converted rpm into a p-queue
 * `interval`/`intervalCap` pair, and an `intervalCap` of 1 meant one running
 * task blocked every other start — a configured concurrency of 10 became an
 * effective concurrency of 1. A token bucket paces *starts* without ever
 * capping how many requests may be in flight, which is the correct separation.
 *
 * Two tiers use this port:
 *
 * 1. **Job admission** (`targetRpm`) — one unit per logical scrape job,
 *    whatever it costs in retries or hops. This is the throughput figure the
 *    run summary reports and the acceptance target is written against.
 * 2. **HTTP egress** (`httpRpmPerHost`) — one unit per outbound request,
 *    including retries and multi-hop platform calls. This is what actually
 *    protects upstream platforms.
 */

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

export interface RateLimiterOptions {
  /** Requests per minute. `0` (or negative) disables limiting entirely. */
  rpm: number;
  /**
   * How many units may be spent at once after an idle period. Defaults to one
   * second's worth, minimum 1.
   *
   * Burst is what lets a small batch reach the concurrency ceiling promptly
   * instead of trickling in one job per interval. It is bounded on purpose: a
   * fixed-window limiter, which allows a whole minute's budget to fire at a
   * window boundary, can emit twice the target rate in a single second.
   */
  burst?: number | undefined;
  now?: (() => number) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

/** Builds the limiter for a target rate, or an unlimited one when disabled. */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  if (!Number.isFinite(options.rpm) || options.rpm <= 0) {
    return unlimitedRateLimiter;
  }
  const refillPerSecond = options.rpm / 60;
  const capacity = Math.max(1, options.burst ?? Math.ceil(refillPerSecond));
  return new TokenBucketRateLimiter({
    refillPerSecond,
    capacity,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
}
