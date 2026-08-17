import { type Logger } from '../logging/logger.js';

import { type HttpClient } from './http-port.js';
import { type ProxyLease, type SessionLease } from './lease-ports.js';

/**
 * Everything a single scrape attempt is handed by the runner.
 *
 * A platform implementation should use only what is in here — it must not
 * reach for process state, construct its own HTTP stack, or read env vars.
 * That is what makes platform code testable against mocked transports.
 */
export interface ScrapeContext {
  /** 1-based attempt number within the retry chain. */
  readonly attempt: number;
  /** Total attempts allowed, useful for deciding how hard to try. */
  readonly maxAttempts: number;
  /** Aborted on run cancellation and on the per-request timeout. */
  readonly signal: AbortSignal;
  readonly http: HttpClient;
  /** `null` when no proxies are configured — a direct connection. */
  readonly proxy: ProxyLease | null;
  /** `null` when the run is not using sessions (the default). */
  readonly session: SessionLease | null;
  readonly logger: Logger;
  /** Injected so tests can control time. */
  readonly now: () => Date;
}
