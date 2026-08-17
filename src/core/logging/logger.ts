/**
 * Minimal structured-logging port.
 *
 * Core and platform code depend on this, not on pino, so tests can pass a
 * silent logger and the web layer can pass its own sink.
 */
export type LogFields = Record<string, unknown>;

export interface LogFn {
  (message: string): void;
  (fields: LogFields, message: string): void;
}

export interface Logger {
  trace: LogFn;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  child(bindings: LogFields): Logger;
}

const noop: LogFn = () => {
  /* intentionally empty */
};

/** Drops everything. Default for tests and for library-style usage. */
export const nullLogger: Logger = {
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  child: () => nullLogger,
};
