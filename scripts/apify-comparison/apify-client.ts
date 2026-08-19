import { ScrapeError } from '../../src/core/models/errors.js';

import { redactString } from './redact.js';

const API_BASE = 'https://api.apify.com/v2';

/**
 * Narrow transport boundary, local to the benchmark.
 *
 * Deliberately NOT the production `HttpClient` port: that one carries proxy
 * leases, session cookies and the pipeline's rate limiter, none of which should
 * ever touch a paid third-party API — and wiring Apify through it is the first
 * step towards Apify becoming a production dependency, which is a non-goal.
 */
export interface ApifyHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface ApifyHttpRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string | undefined;
  readonly timeoutMs: number;
}

export interface ApifyTransport {
  request(request: ApifyHttpRequest): Promise<ApifyHttpResponse>;
}

/** Everything Apify tells us about a finished (or still running) Actor run. */
export interface ApifyRun {
  readonly id: string;
  readonly actId: string | null;
  readonly status: string;
  readonly defaultDatasetId: string | null;
  readonly buildNumber: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly usageTotalUsd: number | null;
  readonly chargedEventCounts: Readonly<Record<string, number>> | null;
  readonly pricingModel: string | null;
  readonly netRxBytes: number | null;
  readonly netTxBytes: number | null;
  readonly runTimeSecs: number | null;
  /** The raw payload, kept for the artifact. Redacted before it is written. */
  readonly raw: unknown;
}

export const TERMINAL_SUCCESS_STATUS = 'SUCCEEDED';

/** Every status Apify documents, split by what the benchmark should do next. */
export const NON_TERMINAL_STATUSES = new Set(['READY', 'RUNNING']);
export const TERMINAL_FAILURE_STATUSES = new Set([
  'FAILED',
  'TIMING-OUT',
  'TIMED-OUT',
  'ABORTING',
  'ABORTED',
]);

export interface ApifyClientOptions {
  readonly transport: ApifyTransport;
  readonly token: string;
  /** Overall wall-clock budget for start + poll + fetch, enforced locally. */
  readonly deadlineMs: number;
  /** Injected so tests do not spend real time in backoff. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly now?: (() => number) | undefined;
}

export interface StartRunInput {
  readonly actorPathId: string;
  readonly input: unknown;
  readonly maxTotalChargeUsd: number;
  readonly maxItems: number;
  /** Apify-side run timeout, in seconds. */
  readonly timeoutSecs: number;
  /** `waitForFinish`, in seconds. The API caps this at 60. */
  readonly waitForFinishSecs: number;
}

const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_SERVER_ERROR_RETRIES = 2;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 8_000;

/**
 * Minimal Apify API v2 client: start a run, wait for it, read its dataset.
 *
 * The token is held in a private field, sent only as an `Authorization: Bearer`
 * header, and passed through `redactString` on the way into every error this
 * class throws. It is never appended to a URL, which is what keeps it out of
 * Apify's own request logs as well as ours.
 */
export class ApifyClient {
  private readonly transport: ApifyTransport;
  private readonly token: string;
  private readonly deadlineMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly startedAt: number;

  constructor(options: ApifyClientOptions) {
    this.transport = options.transport;
    this.token = options.token;
    this.deadlineMs = options.deadlineMs;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? ((): number => Date.now());
    this.startedAt = this.now();
  }

  /**
   * Starts the Actor and waits up to `waitForFinishSecs` server-side.
   *
   * Short runs come back already `SUCCEEDED` from this single call, which is
   * the common case for a handful of direct post URLs and costs no polling.
   */
  async startRun(input: StartRunInput): Promise<ApifyRun> {
    const url = new URL(`${API_BASE}/acts/${input.actorPathId}/runs`);
    url.searchParams.set('waitForFinish', String(input.waitForFinishSecs));
    url.searchParams.set('timeout', String(input.timeoutSecs));
    url.searchParams.set('maxItems', String(input.maxItems));
    // The dollar ceiling Apify itself enforces. The local caps in `options.ts`
    // are the first line of defence; this is the one that survives a bug here.
    url.searchParams.set('maxTotalChargeUsd', String(input.maxTotalChargeUsd));

    const response = await this.send({
      url: url.toString(),
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input.input),
    });

    return parseRun(this.decodeData(response, 'run'));
  }

  async getRun(runId: string): Promise<ApifyRun> {
    const response = await this.send({
      url: `${API_BASE}/actor-runs/${encodeURIComponent(runId)}`,
      method: 'GET',
      headers: {},
    });
    return parseRun(this.decodeData(response, 'run'));
  }

  /**
   * Polls until the run reaches a terminal status or the local deadline expires.
   *
   * The local deadline exists because the Apify-side timeout is a request to a
   * remote service: if the API stops answering, nothing server-side will end
   * this loop.
   */
  async waitForRun(run: ApifyRun): Promise<ApifyRun> {
    let current = run;
    let backoff = INITIAL_BACKOFF_MS;

    while (NON_TERMINAL_STATUSES.has(current.status)) {
      const remaining = this.remainingMs();
      if (remaining <= 0) {
        throw new ScrapeError({
          code: 'timeout',
          message:
            `Apify run ${current.id} was still ${current.status} when the local ` +
            `${this.deadlineMs}ms deadline expired; it may still be running and ` +
            'may still be charged — check the Apify console',
        });
      }
      await this.sleep(Math.min(backoff, remaining));
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      current = await this.getRun(current.id);
    }

    if (current.status !== TERMINAL_SUCCESS_STATUS) {
      const known = TERMINAL_FAILURE_STATUSES.has(current.status);
      throw new ScrapeError({
        code: known ? 'http_error' : 'unknown',
        message:
          `Apify run ${current.id} ended with status ${current.status}` +
          (known ? '' : ' (a status this benchmark does not recognise)'),
      });
    }
    return current;
  }

  /** Reads the run's default dataset. `clean=false` keeps error rows visible. */
  async getDatasetItems(runId: string): Promise<unknown[]> {
    const url = new URL(`${API_BASE}/actor-runs/${encodeURIComponent(runId)}/dataset/items`);
    url.searchParams.set('format', 'json');
    url.searchParams.set('clean', 'false');

    const response = await this.send({ url: url.toString(), method: 'GET', headers: {} });

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      throw new ScrapeError({
        code: 'parse_error',
        message: `Apify dataset for run ${runId} was not valid JSON`,
      });
    }
    if (!Array.isArray(parsed)) {
      throw new ScrapeError({
        code: 'parse_error',
        message: `Apify dataset for run ${runId} was not a JSON array`,
      });
    }
    // Rows stay `unknown`: the Actor's schema is the adapter's problem, and
    // this client must not pretend to know the shape of what it fetched.
    return parsed as unknown[];
  }

  private remainingMs(): number {
    return this.deadlineMs - (this.now() - this.startedAt);
  }

  /**
   * One request, with bounded retries for the failures that are worth retrying.
   *
   * 429 and 5xx get a small number of backed-off attempts; 401 and 402 do not,
   * because no amount of retrying fixes a bad token or an exhausted balance,
   * and retrying a billing refusal is how a benchmark turns one charge into
   * several.
   */
  private async send(request: Omit<ApifyHttpRequest, 'timeoutMs'>): Promise<ApifyHttpResponse> {
    let rateLimitRetries = 0;
    let serverErrorRetries = 0;
    let backoff = INITIAL_BACKOFF_MS;

    for (;;) {
      const remaining = this.remainingMs();
      if (remaining <= 0) {
        throw new ScrapeError({
          code: 'timeout',
          message: `the local ${this.deadlineMs}ms Apify deadline expired before the request completed`,
        });
      }

      let response: ApifyHttpResponse;
      try {
        response = await this.transport.request({
          ...request,
          headers: { ...request.headers, authorization: `Bearer ${this.token}` },
          timeoutMs: remaining,
        });
      } catch (error) {
        throw new ScrapeError({
          code: 'network_error',
          message: `Apify request failed: ${this.safeMessage(error)}`,
          cause: error,
        });
      }

      if (response.status >= 200 && response.status < 300) return response;

      if (response.status === 401 || response.status === 403) {
        throw new ScrapeError({
          code: 'config_error',
          message:
            `Apify rejected the credentials (HTTP ${response.status}). ` +
            'Check APIFY_TOKEN — its value is never printed by this tool.',
        });
      }

      if (response.status === 402) {
        throw new ScrapeError({
          code: 'config_error',
          message:
            'Apify refused the run for billing reasons (HTTP 402): the account is out of ' +
            'credit, or the request exceeded a usage limit. Not retried.',
        });
      }

      if (response.status === 429 && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
        rateLimitRetries += 1;
        await this.sleep(
          Math.max(0, Math.min(this.retryAfterMs(response) ?? backoff, this.remainingMs())),
        );
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        continue;
      }

      if (response.status >= 500 && serverErrorRetries < MAX_SERVER_ERROR_RETRIES) {
        serverErrorRetries += 1;
        await this.sleep(Math.max(0, Math.min(backoff, this.remainingMs())));
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        continue;
      }

      throw new ScrapeError({
        code: response.status === 429 ? 'rate_limited' : 'http_error',
        message:
          `Apify returned HTTP ${response.status}: ` +
          redactString(truncate(response.body), [this.token]),
      });
    }
  }

  private retryAfterMs(response: ApifyHttpResponse): number | null {
    const header = response.headers['retry-after'];
    if (header === undefined) return null;
    const seconds = Number(header);
    return Number.isFinite(seconds) && seconds >= 0
      ? Math.min(seconds * 1_000, MAX_BACKOFF_MS)
      : null;
  }

  private decodeData(response: ApifyHttpResponse, what: string): Record<string, unknown> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      throw new ScrapeError({
        code: 'parse_error',
        message: `Apify ${what} response was not valid JSON`,
      });
    }
    const data = (parsed as { data?: unknown })?.data;
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new ScrapeError({
        code: 'parse_error',
        message: `Apify ${what} response did not contain a "data" object`,
      });
    }
    return data as Record<string, unknown>;
  }

  private safeMessage(error: unknown): string {
    return redactString(error instanceof Error ? error.message : String(error), [this.token]);
  }
}

/**
 * Reads a run payload defensively.
 *
 * Only `id` and `status` are required — everything else is optional because
 * Apify may add, rename or omit fields, and a missing cost figure must surface
 * as `null` in the report rather than as a crash or an invented number.
 */
export function parseRun(data: Record<string, unknown>): ApifyRun {
  const id = typeof data.id === 'string' ? data.id : null;
  const status = typeof data.status === 'string' ? data.status : null;
  if (id === null || status === null) {
    throw new ScrapeError({
      code: 'parse_error',
      message: 'Apify run payload is missing "id" or "status"',
    });
  }

  const stats = isRecord(data.stats) ? data.stats : {};
  const options = isRecord(data.options) ? data.options : {};

  return {
    id,
    status,
    actId: typeof data.actId === 'string' ? data.actId : null,
    defaultDatasetId: typeof data.defaultDatasetId === 'string' ? data.defaultDatasetId : null,
    buildNumber: typeof data.buildNumber === 'string' ? data.buildNumber : null,
    startedAt: typeof data.startedAt === 'string' ? data.startedAt : null,
    finishedAt: typeof data.finishedAt === 'string' ? data.finishedAt : null,
    usageTotalUsd: finiteOrNull(data.usageTotalUsd),
    chargedEventCounts: parseChargedEvents(data.chargedEventCounts),
    pricingModel:
      typeof data.pricingModel === 'string'
        ? data.pricingModel
        : typeof options.pricingModel === 'string'
          ? options.pricingModel
          : null,
    netRxBytes: finiteOrNull(stats.netRxBytes),
    netTxBytes: finiteOrNull(stats.netTxBytes),
    runTimeSecs: finiteOrNull(stats.runTimeSecs),
    raw: data,
  };
}

function parseChargedEvents(value: unknown): Readonly<Record<string, number>> | null {
  if (!isRecord(value)) return null;
  const result: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    const numeric = finiteOrNull(count);
    if (numeric !== null) result[key] = numeric;
  }
  return Object.keys(result).length > 0 ? result : null;
}

/** `null` for anything that is not a real number — never a silent `0`. */
function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncate(body: string, limit = 300): string {
  return body.length <= limit ? body : `${body.slice(0, limit)}…`;
}
