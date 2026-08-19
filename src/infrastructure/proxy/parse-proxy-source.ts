import { type ProxyTarget } from '../../core/scraper/lease-ports.js';
import { type ProxySourceFetchResult } from '../../core/scraper/proxy-source-ports.js';

import { parseProxyEntry, proxyId } from './proxy-config.js';

/**
 * Parses a proxy list that arrived from a live source rather than configuration.
 *
 * Deliberately lenient where `parseProxyList` is strict. A typo in `PROXY_POOL`
 * is an operator mistake and must fail loudly at startup; a malformed line in a
 * list of several thousand free proxies is an ordinary Tuesday, and throwing
 * would let one bad row cost us the entire refresh. Bad entries are counted
 * instead, so the number stays visible without being fatal.
 *
 * Deduplication is by the credential-free `proxyId`, which is the same identity
 * the pool uses. That keeps "the same proxy" meaning one thing everywhere, and
 * is what lets a proxy be recognised across refreshes.
 */
export function parseProxySourceText(raw: string): ProxySourceFetchResult {
  const lines = raw
    .split(/[\r\n,;]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  const seen = new Map<string, ProxyTarget>();
  let malformed = 0;
  let duplicates = 0;

  for (const line of lines) {
    let target: ProxyTarget;
    try {
      target = parseProxyEntry(line);
    } catch {
      malformed += 1;
      continue;
    }

    const id = proxyId(target);
    if (seen.has(id)) {
      duplicates += 1;
      continue;
    }
    seen.set(id, target);
  }

  return {
    targets: [...seen.values()],
    total: lines.length,
    malformed,
    duplicates,
  };
}
