import { destination, pino, type LoggerOptions } from 'pino';

import { type Logger } from '../../core/logging/logger.js';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

export interface CreateLoggerOptions {
  level: LogLevel;
  /** Extra fields attached to every line. */
  bindings?: Record<string, unknown> | undefined;
}

/**
 * Structured logs go to stderr on purpose: stdout is reserved for machine
 * output (`--json` run summaries), so a run can be piped without the log
 * stream corrupting it.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const pinoOptions: LoggerOptions = {
    level: options.level,
    base: options.bindings ?? {},
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return pino(pinoOptions, destination(2));
}
