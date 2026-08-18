import { type RunSummary } from '../models/run-summary.js';

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
      `(effective ${concurrency.effective.toFixed(2)})`,
  );

  // The exact fingerprint of accidental serialization: work was queued and
  // waiting while configured capacity sat unused. This is what a run summary
  // failed to say when a configured concurrency of 10 ran one job at a time.
  if (concurrency.max_observed < concurrency.configured && summary.queue.max_depth > 0) {
    lines.push('');
    lines.push(
      `!  Concurrency underused: ${num(concurrency.configured)} configured, ` +
        `${num(concurrency.max_observed)} observed, while the queue backlog peaked at ` +
        `${num(summary.queue.max_depth)}.`,
    );
    lines.push(
      `   Capacity was available but unused. Effective concurrency ${concurrency.effective.toFixed(2)}` +
        `${concurrency.effective < 1.5 ? ' — this run was effectively sequential.' : '.'}`,
    );
  }

  lines.push('');
  lines.push(`${pad('Queue wait p95')}${ms(summary.queue.wait_p95_ms)}`);
  lines.push(`${pad('Admission wait')}${ms(summary.waits.admission_ms)}`);
  lines.push(`${pad('HTTP limiter wait')}${ms(summary.waits.http_rate_limit_ms)}`);
  lines.push(`${pad('Proxy acquire')}${ms(summary.waits.proxy_acquire_ms)}`);
  lines.push(`${pad('Retry backoff')}${ms(summary.waits.retry_backoff_ms)}`);
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
  if (summary.proxies.configured === 0) {
    lines.push('  none configured (direct connection)');
  } else {
    lines.push(`  ${pad('configured')}${num(summary.proxies.configured)}`);
    lines.push(`  ${pad('used')}${num(summary.proxies.used)}`);
    lines.push(`  ${pad('blocked')}${num(summary.proxies.blocked)}`);
    lines.push(`  ${pad('retired')}${num(summary.proxies.retired)}`);
    lines.push(`  ${pad('failures')}${num(summary.proxies.total_failures)}`);
    for (const proxy of summary.proxies.per_proxy) {
      lines.push(
        `    ${proxy.proxy_id} — ${num(proxy.requests)} req, ` +
          `${num(proxy.successes)} ok, ${num(proxy.failures)} failed` +
          `${proxy.unsuitable > 0 ? `, ${num(proxy.unsuitable)} unsuitable` : ''}` +
          `${proxy.blocked ? ', BLOCKED' : ''}`,
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
