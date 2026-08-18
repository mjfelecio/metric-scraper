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
      `(effective ${throughput.concurrency.effective.toFixed(2)})`,
  );
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

  if (summary.stalled) {
    lines.push('');
    lines.push('  ⚠ a cycle stopped making progress while work was still in flight');
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
