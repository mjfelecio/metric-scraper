import { type StressReport } from './stress-report.js';

function num(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function rate(value: number): string {
  return `${value.toFixed(1)} jobs/min`;
}

function ms(value: number | null): string {
  if (value === null) return '—';
  return `${Math.round(value).toLocaleString('en-US')} ms`;
}

function seconds(value: number): string {
  return `${(value / 1_000).toFixed(1)}s`;
}

function bytes(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} KB`;
  return `${num(value)} B`;
}

/**
 * Human-readable stress-test report for the terminal, following the shape
 * the take-home brief itself sketches (Target / Duration / Jobs submitted /
 * ... / Result: PASS). Must stay a pure projection of `StressReport` -- the
 * printed and persisted (`--json`) forms come from the same object, so they
 * can never disagree, the same rule `format-summary.ts` follows for
 * `RunSummary`.
 *
 * Reports p50/p95/max because that's what `LatencySummary` actually carries
 * -- there is no p99 in this codebase's metrics collector to report honestly.
 */
export function formatStressReport(report: StressReport): string {
  const lines: string[] = [];
  const pad = (label: string): string => label.padEnd(20, ' ');

  lines.push('');
  lines.push('Stress Test');
  lines.push('─'.repeat(56));
  lines.push(`${pad('Profile')}${report.profile}`);
  lines.push(
    `${pad('Target')}${report.targetRpm > 0 ? rate(report.targetRpm) : 'unpaced (burst)'}`,
  );
  lines.push(`${pad('Duration')}${seconds(report.durationMs)}`);
  if (report.requiredSustainedMs !== null) {
    lines.push(
      `${pad('Sustained window')}${seconds(report.sustainedWindowMs)} ` +
        `(required ${seconds(report.requiredSustainedMs)})`,
    );
  }
  lines.push('');
  lines.push(`${pad('Jobs submitted')}${num(report.totals.submitted)}`);
  lines.push(`${pad('Jobs completed')}${num(report.totals.completed)}`);
  lines.push(
    `${pad('Jobs failed')}${num(report.totals.failures)}  (${pct(1 - report.totals.successRate)})`,
  );
  lines.push('');
  lines.push(`${pad('Actual throughput')}${rate(report.actualThroughputRpm)}`);
  lines.push(`${pad('p50 latency')}${ms(report.latency.p50_ms)}`);
  lines.push(`${pad('p95 latency')}${ms(report.latency.p95_ms)}`);
  lines.push(`${pad('max latency')}${ms(report.latency.max_ms)}`);
  lines.push('');
  lines.push(`${pad('HTTP requests')}${num(report.totals.platformHttpRequests)}`);
  lines.push(`${pad('Retries')}${num(report.totals.retries)}`);
  lines.push('');
  lines.push(`${pad('Peak queue')}${num(report.peakQueueDepth)}`);
  lines.push(
    `${pad('Peak memory')}${report.peakMemoryRssBytes === null ? '—' : bytes(report.peakMemoryRssBytes)}` +
      (report.memoryGrowthRatio !== null
        ? `  (${report.memoryGrowthRatio.toFixed(2)}x growth)`
        : ''),
  );
  lines.push('');
  lines.push(
    `${pad('Proxy leases')}${num(report.proxies.per_proxy.reduce((sum, proxy) => sum + proxy.requests, 0))}`,
  );
  lines.push(
    `${pad('Proxies')}${num(report.proxies.configured)} configured, ` +
      `${num(report.proxies.cooling)} cooling, ${num(report.proxies.retired)} retired`,
  );
  if (report.bandwidth !== null) {
    lines.push(
      `${pad('Bandwidth')}${bytes(report.bandwidth.totalBytes)} over ${num(report.bandwidth.requests)} wire requests`,
    );
    lines.push(
      `${pad('Bytes/request')}${report.bandwidth.bytesPerRequest === null ? '—' : bytes(report.bandwidth.bytesPerRequest)}`,
    );
  }

  lines.push('');
  lines.push('Phases');
  for (const phase of report.phases) {
    lines.push(
      `  ${phase.name.padEnd(18, ' ')}${num(phase.requests)} req, ${pct(phase.successRate)} success, ` +
        `${seconds(phase.durationMs)}`,
    );
  }

  if (report.findings.length > 0) {
    lines.push('');
    lines.push('Findings');
    for (const finding of report.findings) {
      const marker = finding.severity === 'fail' ? '✗' : '!';
      lines.push(`  ${marker} [${finding.kind}] ${finding.message}`);
    }
  }

  lines.push('');
  lines.push(`Result: ${report.verdict}`);
  lines.push('─'.repeat(56));
  lines.push('');

  return lines.join('\n');
}
