import { z } from 'zod';

import { type FailureStatus, type ScrapeStatus } from './status.js';

/**
 * Coarse machine-readable error causes. These are deliberately transport- and
 * platform-agnostic: a platform implementation maps whatever it observes onto
 * one of these so the runner, retry policy and metrics never need to know how
 * TikTok or Instagram actually fail.
 */
export const SCRAPE_ERROR_CODES = [
  'not_implemented',
  'invalid_url',
  'unsupported_platform',
  'timeout',
  'network_error',
  'http_error',
  'rate_limited',
  'blocked',
  'not_found',
  'private',
  'parse_error',
  'proxy_error',
  'session_error',
  'config_error',
  'output_error',
  'cancelled',
  'unknown',
] as const;

export const ScrapeErrorCodeSchema = z.enum(SCRAPE_ERROR_CODES);

export type ScrapeErrorCode = z.infer<typeof ScrapeErrorCodeSchema>;

export const ScrapeErrorInfoSchema = z.object({
  code: ScrapeErrorCodeSchema,
  message: z.string(),
  /** Whether another attempt could plausibly succeed. */
  retryable: z.boolean(),
});

export type ScrapeErrorInfo = z.infer<typeof ScrapeErrorInfoSchema>;

export interface ScrapeErrorOptions {
  code: ScrapeErrorCode;
  message: string;
  /** Status this error should be recorded as. Defaults to the code's mapping. */
  status?: ScrapeStatus | undefined;
  retryable?: boolean | undefined;
  cause?: unknown;
}

const DEFAULT_STATUS_BY_CODE: Record<ScrapeErrorCode, FailureStatus> = {
  not_implemented: 'error',
  invalid_url: 'error',
  unsupported_platform: 'error',
  timeout: 'error',
  network_error: 'error',
  http_error: 'error',
  rate_limited: 'rate_limited',
  blocked: 'rate_limited',
  not_found: 'not_found',
  private: 'private',
  parse_error: 'error',
  proxy_error: 'error',
  session_error: 'error',
  config_error: 'error',
  output_error: 'error',
  cancelled: 'error',
  unknown: 'error',
};

const DEFAULT_RETRYABLE_BY_CODE: Record<ScrapeErrorCode, boolean> = {
  not_implemented: false,
  invalid_url: false,
  unsupported_platform: false,
  timeout: true,
  network_error: true,
  http_error: true,
  rate_limited: true,
  blocked: true,
  not_found: false,
  private: false,
  parse_error: false,
  proxy_error: true,
  session_error: true,
  config_error: false,
  output_error: false,
  cancelled: false,
  unknown: false,
};

export function defaultStatusForCode(code: ScrapeErrorCode): FailureStatus {
  return DEFAULT_STATUS_BY_CODE[code];
}

export function defaultRetryableForCode(code: ScrapeErrorCode): boolean {
  return DEFAULT_RETRYABLE_BY_CODE[code];
}

/**
 * The one error type that crosses layer boundaries. Anything thrown inside a
 * scraper is normalised into this before the runner sees it, which is what
 * lets every failure become a row instead of a dropped job.
 */
export class ScrapeError extends Error {
  readonly code: ScrapeErrorCode;
  readonly status: ScrapeStatus;
  readonly retryable: boolean;

  constructor(options: ScrapeErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ScrapeError';
    this.code = options.code;
    this.status = options.status ?? defaultStatusForCode(options.code);
    this.retryable = options.retryable ?? defaultRetryableForCode(options.code);
  }

  toInfo(): ScrapeErrorInfo {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }

  static isScrapeError(value: unknown): value is ScrapeError {
    return value instanceof ScrapeError;
  }

  /** Normalise an arbitrary thrown value into a `ScrapeError`. */
  static from(value: unknown): ScrapeError {
    if (ScrapeError.isScrapeError(value)) {
      return value;
    }
    if (value instanceof Error) {
      // AbortError is what fetch/AbortSignal throws on timeout or cancellation.
      const code: ScrapeErrorCode = value.name === 'AbortError' ? 'timeout' : 'unknown';
      return new ScrapeError({ code, message: value.message || value.name, cause: value });
    }
    return new ScrapeError({ code: 'unknown', message: String(value), cause: value });
  }
}
