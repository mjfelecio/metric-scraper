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
  lines.push(`${pad('Successes')}${num(summary.totals.successes)}`);
  lines.push(`${pad('Failures')}${num(summary.totals.failures)}`);
  lines.push(`${pad('Success rate')}${pct(summary.totals.success_rate)}`);
  lines.push(
    `${pad('Throughput')}${rate(summary.throughput.requests_per_minute)} ` +
      `(target ${num(summary.throughput.target_rpm)}, concurrency ${num(summary.throughput.concurrency)})`,
  );
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
    lines.push(`  ${pad('failures')}${num(summary.proxies.total_failures)}`);
    for (const proxy of summary.proxies.per_proxy) {
      lines.push(
        `    ${proxy.proxy_id} — ${num(proxy.requests)} req, ` +
          `${num(proxy.successes)} ok, ${num(proxy.failures)} failed` +
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
