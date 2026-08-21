import { formatConcurrencyFinding } from '../concurrency/format-concurrency-finding.js';
import { summarizeFailureConcentration } from '../metrics/proxy-insights.js';
import { type SessionSummary } from '../models/session-summary.js';
import { formatDuration } from '../schedule/duration.js';

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
 * Human-readable session summary for the terminal.
 *
 * Like {@link formatRunSummary}, this must stay a pure projection of the
 * `SessionSummary` object so the printed and persisted forms can never
 * disagree.
 */
export function formatSessionSummary(summary: SessionSummary): string {
  const lines: string[] = [];
  const pad = (label: string): string => label.padEnd(24, ' ');

  const { schedule, throughput } = summary;
  const target = throughput.target_rpm;
  const sustained = throughput.sustained_target_ms;

  lines.push('');
  lines.push('═'.repeat(60));
  lines.push(`Session summary  ${summary.session_id}`);
  lines.push('═'.repeat(60));
  lines.push(`${pad('Platform')}${summary.platform ?? 'mixed'}`);
  lines.push(`${pad('Duration')}${formatDuration(summary.duration_ms)}`);
  lines.push(
    `${pad('Interval')}${
      schedule.interval_ms === 0 ? 'back-to-back' : formatDuration(schedule.interval_ms)
    }`,
  );
  lines.push(`${pad('Stopped because')}${schedule.stop_reason}`);

  lines.push('');
  lines.push('Cycles');
  lines.push(`  ${pad('started')}${num(summary.cycles.started)}`);
  lines.push(`  ${pad('completed')}${num(summary.cycles.completed)}`);
  lines.push(`  ${pad('failed')}${num(summary.cycles.failed)}`);
  lines.push(
    `  ${pad('overran interval')}${num(summary.cycles.overran)}` +
      (summary.cycles.overran > 0 ? '   (cycles ran longer than the interval)' : ''),
  );

  lines.push('');
  lines.push(`${pad('Total requests')}${num(summary.totals.requests)}`);
  lines.push(`${pad('Successes')}${num(summary.totals.successes)}`);
  lines.push(`${pad('Failures')}${num(summary.totals.failures)}`);
  lines.push(`${pad('Success rate')}${pct(summary.totals.success_rate)}`);

  lines.push('');
  lines.push('Throughput');
  lines.push(`  ${pad('target')}${rate(target)}`);
  lines.push(
    `  ${pad('concurrency')}${num(throughput.concurrency.max_observed)} observed / ` +
      `${num(throughput.concurrency.configured)} configured ` +
      `(${num(throughput.concurrency.achievable)} achievable; ` +
      `effective ${throughput.concurrency.effective.toFixed(2)})`,
  );
  for (const finding of throughput.concurrency.findings) {
    lines.push(
      `  ${finding.severity === 'warning' ? '!' : 'i'} ${formatConcurrencyFinding(finding, throughput.concurrency)}`,
    );
  }
  lines.push(`  ${pad('active')}${rate(throughput.active_rpm)}   (excludes idle gaps)`);
  lines.push(`  ${pad('wall clock')}${rate(throughput.wall_clock_rpm)}   (includes idle gaps)`);
  lines.push(`  ${pad('peak')}${rate(throughput.peak_rpm)}`);
  lines.push(
    `  ${pad('sustained >= target')}${
      target <= 0 ? '— (no target set)' : formatDuration(sustained)
    }`,
  );

  lines.push('');
  lines.push(`${pad('Latency p50')}${ms(summary.latency.p50_ms)}`);
  lines.push(`${pad('Latency p95')}${ms(summary.latency.p95_ms)}`);
  lines.push(`${pad('Latency max')}${ms(summary.latency.max_ms)}`);

  lines.push('');
  lines.push('Queue delay   (enqueue to job start; combined across cycles)');
  lines.push(`  ${pad('max depth')}${num(summary.queue.max_depth)}`);
  lines.push(`  ${pad('wait count')}${num(summary.queue.wait_count)}`);
  lines.push(`  ${pad('wait total')}${ms(summary.queue.wait_total_ms)}`);
  lines.push(`  ${pad('wait mean')}${ms(summary.queue.wait_mean_ms)}`);
  lines.push(`  ${pad('wait max')}${ms(summary.queue.wait_max_ms)}`);

  lines.push('');
  lines.push('Aggregate waits   (aggregate job-time; concurrent waits may overlap)');
  lines.push(`  ${pad('admission')}${ms(summary.waits.admission_total_ms)}`);
  lines.push(`  ${pad('HTTP limiter')}${ms(summary.waits.http_rate_limit_total_ms)}`);
  lines.push(`  ${pad('proxy acquire')}${ms(summary.waits.proxy_acquire_total_ms)}`);
  lines.push(`  ${pad('retry backoff')}${ms(summary.waits.retry_backoff_total_ms)}`);

  lines.push('');
  lines.push('Status breakdown');
  const statuses = Object.entries(summary.status_breakdown).filter(([, count]) => count > 0);
  if (statuses.length === 0) {
    lines.push('  (none)');
  } else {
    for (const [status, count] of statuses) {
      lines.push(`  ${status.padEnd(22, ' ')}${num(count)}`);
    }
  }

  const errors = Object.entries(summary.error_breakdown).filter(([, count]) => count > 0);
  if (errors.length > 0) {
    lines.push('');
    lines.push('Error breakdown');
    for (const [code, count] of errors) {
      lines.push(`  ${code.padEnd(22, ' ')}${num(count)}`);
    }
  }

  lines.push('');
  lines.push('Retries   (counted separately; never included in throughput)');
  lines.push(`  ${pad('total retries')}${num(summary.retries.total_retries)}`);
  lines.push(`  ${pad('retried requests')}${num(summary.retries.retried_requests)}`);
  lines.push(`  ${pad('exhausted')}${num(summary.retries.exhausted_requests)}`);

  if (summary.proxies.configured > 0 || summary.proxies.source !== null) {
    const proxies = summary.proxies;
    lines.push('');
    lines.push('Proxies   (cumulative over the session; state as it stood at the end)');
    lines.push(`  ${pad('configured')}${num(proxies.configured)}`);
    lines.push(`  ${pad('usable at end')}${num(proxies.available)}`);
    lines.push(
      `  ${pad('capacity at end')}${proxies.capacity === null ? 'unknown' : num(proxies.capacity)}`,
    );
    lines.push(`  ${pad('cooling at end')}${num(proxies.cooling)}`);
    lines.push(`  ${pad('retired')}${num(proxies.retired)}`);
    lines.push(`  ${pad('failures')}${num(proxies.total_failures)}`);
    if (proxies.source !== null) {
      const source = proxies.source;
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
      lines.push(
        `  ${pad('pool exhausted')}${num(proxies.pool_exhausted)} time(s) — every proxy was out at once`,
      );
    }
    for (const proxy of proxies.per_proxy) {
      lines.push(
        `    ${proxy.label} ${proxy.proxy_id} — ${proxy.state.toUpperCase()} — ` +
          `${num(proxy.requests)} req, ${num(proxy.successes)} ok, ${num(proxy.failures)} failed`,
      );
    }

    const concentration = summarizeFailureConcentration(proxies.per_proxy);
    if (concentration.concentrated) {
      lines.push('');
      lines.push(
        `  ! ${(concentration.topShare * 100).toFixed(0)}% of proxy failures are on ` +
          `${concentration.worst.map((proxy) => proxy.label).join(' and ')}`,
      );
    }
  }

  if (summary.stall_episodes.length > 0) {
    lines.push('');
    lines.push(
      `  ${summary.stalled ? '⚠' : '✓'} ${num(summary.stall_episodes.length)} stall episode(s)` +
        `${summary.stalled ? '; the latest is still active' : '; all recovered'}`,
    );
  }

  lines.push('');
  lines.push('Output');
  lines.push(`  ${pad('rows written')}${num(summary.output.rows_written)}`);
  lines.push(`  ${pad('snapshots')}${summary.output.snapshots_path ?? '(not persisted)'}`);
  lines.push(`  ${pad('summary')}${summary.output.summary_path ?? '(not persisted)'}`);
  lines.push(`  ${pad('cycle summaries')}${summary.output.cycles_dir ?? '(not persisted)'}`);
  lines.push('═'.repeat(60));
  lines.push('');

  return lines.join('\n');
}
