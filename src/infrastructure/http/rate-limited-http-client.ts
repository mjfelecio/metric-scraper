import {
  createRateLimiter,
  unlimitedRateLimiter,
  type RateLimiter,
} from '../../core/rate-limit/rate-limit.js';
import {
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from '../../core/scraper/http-port.js';

export interface RateLimitedHttpClientOptions {
  inner: HttpClient;
  /**
   * Outbound requests per minute, per host. A plain number applies the same
   * ceiling to every host; a function is called with each request's host so
   * callers can vary the rate per host (e.g. by platform). `0` — from either
   * form — disables limiting for that host.
   */
  rpmPerHost: number | ((host: string) => number);
  /**
   * Longest a request may spend queued on the limiter before it is turned away
   * with a retryable `throttled` error. Takes the same two shapes as
   * `rpmPerHost`, so a caller can vary it per host. Omitted (or `0`) waits
   * indefinitely. See `AcquireOptions.maxWaitMs` for why a bound is needed.
   */
  maxWaitMs?: number | ((host: string) => number) | undefined;
  /** Units spendable at once after idle. See `RateLimiterOptions.burst`. */
  burst?: number | undefined;
  /** Called with the time spent waiting on the limiter, so it stays visible. */
  onWait?: ((waitMs: number, host: string) => void) | undefined;
  now?: (() => number) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

/**
 * Caps actual outbound request rate, per host.
 *
 * This sits at the `HttpClient` port rather than at the task queue, which is
 * the whole point: every request passes through here, so retries and the
 * multi-hop calls a platform scraper makes internally are all counted. A job
 * is one unit of `targetRpm`, but a TikTok job issues two requests and may
 * retry twice — that traffic is invisible to a job-level limiter and would
 * otherwise leave upstream unprotected.
 *
 * Waiting here happens inside a job, so it consumes a concurrency slot. That
 * is genuine backpressure rather than a bug, but it is indistinguishable from
 * one unless it is measured — hence `onWait`.
 *
 * It is also bounded, via `maxWaitMs`. The wait sits inside the caller's
 * attempt timeout, so an unbounded queue does not slow a job down, it kills it
 * partway through: earlier hops have already spent their tokens by then, and
 * their results are discarded when the attempt aborts. Turning the request away
 * early converts that into a cheap retry instead.
 */
export class RateLimitedHttpClient implements HttpClient {
  private readonly inner: HttpClient;
  private readonly resolveRpm: (host: string) => number;
  private readonly resolveMaxWaitMs: (host: string) => number | undefined;
  private readonly burst: number | undefined;
  private readonly onWait: ((waitMs: number, host: string) => void) | undefined;
  private readonly now: () => number;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;
  private readonly limiters = new Map<string, RateLimiter>();

  constructor(options: RateLimitedHttpClientOptions) {
    this.inner = options.inner;
    this.resolveRpm =
      typeof options.rpmPerHost === 'function'
        ? options.rpmPerHost
        : () => options.rpmPerHost as number;
    const maxWaitMs = options.maxWaitMs;
    this.resolveMaxWaitMs =
      typeof maxWaitMs === 'function' ? maxWaitMs : (): number | undefined => maxWaitMs;
    this.burst = options.burst;
    this.onWait = options.onWait;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep;
  }

  async request(request: HttpRequest): Promise<HttpResponse> {
    const host = hostOf(request.url);
    const limiter = this.limiterFor(host);
    const maxWaitMs = this.resolveMaxWaitMs(host);

    const startedAt = this.now();
    try {
      await limiter.acquire(request.signal, { maxWaitMs });
    } finally {
      // Reported from a `finally` so a wait that ended in rejection still lands
      // in the run's wait telemetry. Charging only successful waits would hide
      // exactly the saturation that caused the rejections.
      const waited = Math.max(0, this.now() - startedAt);
      if (waited > 0) {
        this.onWait?.(waited, host);
      }
    }

    return await this.inner.request(request);
  }

  private limiterFor(host: string): RateLimiter {
    let limiter = this.limiters.get(host);
    if (limiter === undefined) {
      const rpm = this.resolveRpm(host);
      limiter =
        Number.isFinite(rpm) && rpm > 0
          ? createRateLimiter({
              rpm,
              ...(this.burst === undefined ? {} : { burst: this.burst }),
              now: this.now,
              ...(this.sleep === undefined ? {} : { sleep: this.sleep }),
            })
          : unlimitedRateLimiter;
      this.limiters.set(host, limiter);
    }
    return limiter;
  }
}

/** Falls back to the raw string so an unparseable URL still gets its own budget. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
