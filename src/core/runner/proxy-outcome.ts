import { type ScrapeErrorCode } from '../models/errors.js';
import { type ScrapeResult } from '../models/scrape-result.js';
import { type ProxyOutcome } from '../scraper/lease-ports.js';

/**
 * What one attempt says about the proxy it used.
 *
 * This is the single definition of proxy health in the system: the pool's
 * rotation state and the per-proxy statistics in the run summary are both
 * derived from this one call, so the two can never classify the same event
 * differently.
 *
 * The distinction that matters is *whose* problem the failure was:
 *
 * - a URL that is gone or private is a fact about the URL. The proxy did its
 *   job and fetched the answer, so it stays credited as healthy.
 * - a transport or upstream failure is a fact about the path we took, whether
 *   or not it is worth retrying. `retryable` is a retry decision, not a health
 *   decision, and reading it as one is what let a geo-blocked proxy reset its
 *   own failure counter on every 451.
 * - some outcomes say nothing either way. Those count as neither, because
 *   crediting them keeps a bad proxy alive and blaming them benches a good one
 *   for a fault it did not have.
 */
export function classifyProxyOutcome(result: ScrapeResult): ProxyOutcome {
  if (result.outcome === 'ok') return 'success';
  if (result.status === 'rate_limited' || result.error.code === 'blocked') return 'blocked';
  return OUTCOME_BY_CODE[result.error.code];
}

const OUTCOME_BY_CODE: Record<ScrapeErrorCode, ProxyOutcome> = {
  // The proxy successfully carried a request and brought back a definitive
  // answer about the URL. That is a healthy use of it.
  not_found: 'success',
  private: 'success',

  // The exit node is in the wrong place for this target. A cooldown cannot
  // move an IP to another jurisdiction, so this gets its own signal.
  geo_blocked: 'unsuitable',

  // Attributable to the path: reached over this proxy and failed there.
  // Non-retryable ones (a 4xx we cannot use) count too — the request failed
  // through this exit node, which is exactly what "unhealthy" means.
  http_error: 'failure',
  timeout: 'failure',
  network_error: 'failure',
  proxy_error: 'failure',
  rate_limited: 'blocked',
  blocked: 'blocked',

  // Says nothing about the proxy.
  // `parse_error` in particular is deliberately neutral: a body we cannot
  // parse is usually our parser or the platform changing, and blaming the
  // proxy for it would bench the whole pool over one deploy-shaped bug.
  parse_error: 'neutral',
  cancelled: 'neutral',
  session_error: 'neutral',
  invalid_url: 'neutral',
  unsupported_platform: 'neutral',
  not_implemented: 'neutral',
  config_error: 'neutral',
  output_error: 'neutral',
  unknown: 'neutral',
};
