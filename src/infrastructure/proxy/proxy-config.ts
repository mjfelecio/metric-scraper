import { ScrapeError } from '../../core/models/errors.js';
import { type ProxyProtocol, type ProxyTarget } from '../../core/scraper/lease-ports.js';

const SUPPORTED_PROTOCOLS: readonly ProxyProtocol[] = ['http', 'https', 'socks4', 'socks5'];

/**
 * Parses a proxy list that came from configuration — never from source code.
 *
 * Accepts comma-, semicolon- or newline-separated entries of the form
 * `protocol://[user:pass@]host:port`. Credentials stay inside `ProxyTarget`;
 * the derived `id` is credential-free and is the only form that reaches logs,
 * metrics or the run summary.
 */
export function parseProxyList(raw: string): ProxyTarget[] {
  const entries = raw
    .split(/[\n,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !entry.startsWith('#'));

  return entries.map(parseProxyEntry);
}

export function parseProxyEntry(entry: string): ProxyTarget {
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    throw new ScrapeError({
      code: 'config_error',
      message: `invalid proxy entry (expected protocol://[user:pass@]host:port): ${redactEntry(entry)}`,
    });
  }

  const protocol = url.protocol.replace(':', '').toLowerCase();
  if (!isSupportedProtocol(protocol)) {
    throw new ScrapeError({
      code: 'config_error',
      message: `unsupported proxy protocol "${protocol}" (supported: ${SUPPORTED_PROTOCOLS.join(', ')})`,
    });
  }

  if (url.hostname.length === 0) {
    throw new ScrapeError({
      code: 'config_error',
      message: `proxy entry has no host: ${redactEntry(entry)}`,
    });
  }

  const port = Number.parseInt(url.port, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new ScrapeError({
      code: 'config_error',
      message: `proxy entry must include a valid port: ${redactEntry(entry)}`,
    });
  }

  return {
    protocol,
    host: url.hostname,
    port,
    username: url.username === '' ? null : decodeURIComponent(url.username),
    password: url.password === '' ? null : decodeURIComponent(url.password),
    url: url.toString(),
  };
}

/** Stable identifier safe to log and to publish in a run summary. */
export function proxyId(target: ProxyTarget): string {
  return `${target.protocol}://${target.host}:${target.port}`;
}

function isSupportedProtocol(value: string): value is ProxyProtocol {
  return (SUPPORTED_PROTOCOLS as readonly string[]).includes(value);
}

/** Strips any `user:pass@` section so a bad entry can be reported safely. */
export function redactEntry(entry: string): string {
  return entry.replace(/\/\/[^@/]*@/, '//***@');
}
