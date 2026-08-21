import { formatConcurrencyFinding } from '../concurrency/format-concurrency-finding.js';
import { summarizeFailureConcentration } from '../metrics/proxy-insights.js';
import { type ProxyUsage, type RunSummary } from '../models/run-summary.js';

function ms(value: number | null): string {
  if (value === null) return '—';
  return `${Math.round(value).toLocaleString('en-US')} ms`;
}

function num(value: number): string {
  return value.toLocaleString('en-US');
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function rate(value: number): string {
  return `${value.toFixed(1)} req/min`;
}

/** One proxy on one line: what it is doing, how it did, and why. */
function proxyLine(proxy: ProxyUsage): string {
  const parts = [
    `${proxy.label} ${proxy.proxy_id}`,
    proxy.state.toUpperCase(),
    `${num(proxy.requests)} req, ${num(proxy.successes)} ok, ${num(proxy.failures)} failed`,
  ];

  if (proxy.in_flight > 0) parts.push(`${num(proxy.in_flight)} in flight`);
  if (proxy.eligible_at !== null) parts.push(`until ${clock(proxy.eligible_at)}`);
  if (proxy.unhealthy_since !== null && proxy.eligible_at === null) {
    parts.push(`since ${clock(proxy.unhealthy_since)}`);
  }

  const errors = Object.entries(proxy.by_error_code)
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([code, count]) => `${code}x${count}`);
  if (errors.length > 0) parts.push(errors.join(', '));

  return parts.join(' — ');
}

/** Wall-clock time only: a summary is read next to a log, not across days. */
function clock(iso: string): string {
  return new Date(iso).toISOString().slice(11, 19);
}

/**
 * Human-readable run summary for the terminal.
 *
 * The machine-readable form is the `RunSummary` object itself, written to
 * disk as JSON — this function must stay a pure projection of it so the two
 * can never disagree.
 */
export function formatRunSummary(summary: RunSummary): string {
  const lines: string[] = [];
  const pad = (label: string): string => label.padEnd(22, ' ');

  lines.push('');
  lines.push('─'.repeat(56));
  lines.push(`Run summary  ${summary.run_id}`);
  lines.push('─'.repeat(56));
  lines.push(`${pad('Platform')}${summary.platform ?? 'mixed'}`);
  lines.push(`${pad('Duration')}${ms(summary.duration_ms)}`);
  lines.push('');
  lines.push(`${pad('Total requests')}${num(summary.totals.requests)}`);
  lines.push(`${pad('Platform HTTP calls')}${num(summary.totals.platform_http_requests)}`);
  lines.push(`${pad('Successes')}${num(summary.totals.successes)}`);
  lines.push(`${pad('Failures')}${num(summary.totals.failures)}`);
  lines.push(`${pad('Success rate')}${pct(summary.totals.success_rate)}`);
  const concurrency = summary.throughput.concurrency;
  lines.push(
    `${pad('Throughput')}${rate(summary.throughput.requests_per_minute)} ` +
      `(target ${num(summary.throughput.target_rpm)} rpm)`,
  );
  lines.push(
    `${pad('Concurrency')}${num(concurrency.max_observed)} observed / ` +
      `${num(concurrency.configured)} configured  ` +
      `(${num(concurrency.achievable)} achievable; effective ${concurrency.effective.toFixed(2)})`,
  );

  for (const finding of concurrency.findings) {
    lines.push(
      '',
      `${finding.severity === 'warning' ? '!' : 'i'}  ${formatConcurrencyFinding(finding, concurrency)}`,
    );
  }

  lines.push('');
  lines.push('Queue delay   (enqueue to job start)');
  lines.push(`  ${pad('count')}${num(summary.queue.wait_count)}`);
  lines.push(`  ${pad('total')}${ms(summary.queue.wait_total_ms)}`);
  lines.push(`  ${pad('mean')}${ms(summary.queue.wait_mean_ms)}`);
  lines.push(`  ${pad('p95')}${ms(summary.queue.wait_p95_ms)}`);
  lines.push(`  ${pad('max')}${ms(summary.queue.wait_max_ms)}`);
  lines.push('');
  lines.push('Aggregate waits   (aggregate job-time; concurrent waits may overlap)');
  lines.push(`  ${pad('admission')}${ms(summary.waits.admission_total_ms)}`);
  lines.push(`  ${pad('HTTP limiter')}${ms(summary.waits.http_rate_limit_total_ms)}`);
  lines.push(`  ${pad('proxy acquire')}${ms(summary.waits.proxy_acquire_total_ms)}`);
  lines.push(`  ${pad('retry backoff')}${ms(summary.waits.retry_backoff_total_ms)}`);
  lines.push('');
  lines.push(`${pad('Latency p50')}${ms(summary.latency.p50_ms)}`);
  lines.push(`${pad('Latency p95')}${ms(summary.latency.p95_ms)}`);
  lines.push(`${pad('Latency max')}${ms(summary.latency.max_ms)}`);

  lines.push('');
  lines.push('Status breakdown');
  const statuses = Object.entries(summary.status_breakdown).filter(([, count]) => count > 0);
  if (statuses.length === 0) {
    lines.push('  (none)');
  } else {
    for (const [status, count] of statuses) {
      lines.push(`  ${status.padEnd(20, ' ')}${num(count)}`);
    }
  }

  lines.push('');
  lines.push('Sessions');
  if (summary.sessions.configured === 0) {
    lines.push('  none configured');
  } else {
    lines.push(`  ${pad('configured')}${num(summary.sessions.configured)}`);
    lines.push(`  ${pad('used')}${num(summary.sessions.used)}`);
    lines.push(`  ${pad('blocked')}${num(summary.sessions.blocked)}`);
    lines.push(`  ${pad('failures')}${num(summary.sessions.total_failures)}`);
  }

  const errors = Object.entries(summary.error_breakdown).filter(([, count]) => count > 0);
  if (errors.length > 0) {
    lines.push('');
    lines.push('Error breakdown');
    for (const [code, count] of errors) {
      lines.push(`  ${code.padEnd(20, ' ')}${num(count)}`);
    }
  }

  lines.push('');
  lines.push('Retries');
  lines.push(`  ${pad('total retries')}${num(summary.retries.total_retries)}`);
  lines.push(`  ${pad('retried requests')}${num(summary.retries.retried_requests)}`);
  lines.push(`  ${pad('exhausted')}${num(summary.retries.exhausted_requests)}`);

  lines.push('');
  lines.push('Proxies');
  if (summary.proxies.configured === 0 && summary.proxies.source === null) {
    lines.push('  none configured (direct connection)');
  } else {
    const proxies = summary.proxies;
    lines.push(`  ${pad('configured')}${num(proxies.configured)}`);
    lines.push(
      `  ${pad('usable')}${num(proxies.available)}` +
        `${proxies.untested > 0 ? `  (${num(proxies.untested)} never used)` : ''}`,
    );
    lines.push(`  ${pad('cooling')}${num(proxies.cooling)}`);
    lines.push(`  ${pad('retired')}${num(proxies.retired)}`);
    lines.push(
      `  ${pad('in flight')}${num(proxies.total_in_flight)} on ${num(proxies.used)} used` +
        ` (capacity ${proxies.capacity === null ? 'unknown' : num(proxies.capacity)})`,
    );
    lines.push(`  ${pad('failures')}${num(proxies.total_failures)}`);
    if (proxies.source !== null) {
      const source = proxies.source;
      // The supply is its own story: a pool short of its target because the
      // candidates ran out reads very differently from one short because the
      // proxies keep failing.
      lines.push(
        `  ${pad('source')}${source.name} — ${num(source.admitted)} admitted, ` +
          `${num(source.candidates)} waiting, ${num(source.rejected)} rejected ` +
          `(target ${num(source.target_capacity)} slots)`,
      );
      lines.push(
        `  ${pad('validation')}${num(source.probe_successes)} passed / ` +
          `${num(source.probe_failures)} failed`,
      );
      if (source.refresh_failures > 0) {
        lines.push(
          `  ${pad('source refresh')}${num(source.refresh_failures)} failure(s)` +
            `${source.last_refresh_error === null ? '' : ` — ${source.last_refresh_error}`}`,
        );
      }
    }
    if (proxies.pool_exhausted > 0) {
      // The pool, not the platform, was the limit. Worth saying outright: it is
      // otherwise indistinguishable from an upstream slowdown.
      lines.push(
        `  ${pad('pool exhausted')}${num(proxies.pool_exhausted)} time(s) — every proxy was out at once`,
      );
    }
    for (const proxy of proxies.per_proxy) {
      lines.push(`    ${proxyLine(proxy)}`);
    }

    const concentration = summarizeFailureConcentration(proxies.per_proxy);
    if (concentration.concentrated) {
      lines.push('');
      lines.push(
        `!  ${(concentration.topShare * 100).toFixed(0)}% of proxy failures are on ` +
          `${concentration.worst.map((proxy) => proxy.label).join(' and ')}. ` +
          'The rest of the pool is carrying its share.',
      );
    }
  }

  lines.push('');
  lines.push('Output');
  lines.push(`  ${pad('rows written')}${num(summary.output.rows_written)}`);
  lines.push(`  ${pad('snapshots')}${summary.output.snapshots_path ?? '(not persisted)'}`);
  lines.push(`  ${pad('summary')}${summary.output.summary_path ?? '(not persisted)'}`);
  lines.push('─'.repeat(56));
  lines.push('');

  return lines.join('\n');
}
