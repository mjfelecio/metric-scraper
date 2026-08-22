import { valueOr, type CapacitySimulationResult } from '../../core/capacity/index.js';

export interface ChartMarkup {
  readonly workload: string;
  readonly traffic: string;
  readonly bandwidth: string;
  readonly concurrency: string;
  readonly proxy: string;
  readonly growth: string;
}

/** Six small, dependency-free inline SVGs. All coordinates are finite by construction. */
export function renderCapacityCharts(result: CapacitySimulationResult): ChartMarkup {
  const sampled = sample(result.timeline, 60);
  return {
    workload: lineChart(
      'Daily logical jobs',
      sampled.map((point) => point.scrapeJobs),
      'workload',
    ),
    traffic: groupedBars(
      'HTTP requests/day',
      [
        ['baseline', valueOr(result.traffic.baselineHttpRequestsPerDay, 0)],
        ['adjusted', valueOr(result.traffic.adjustedHttpRequestsPerDay, 0)],
      ],
      'traffic',
    ),
    bandwidth: groupedBars(
      'Decimal GB/day',
      [
        ['baseline', valueOr(result.bandwidth.baselineGbPerDay, 0)],
        ['adjusted', valueOr(result.bandwidth.adjustedGbPerDay, 0)],
      ],
      'bandwidth',
    ),
    concurrency: groupedBars(
      'Little’s Law concurrency',
      [
        ['jobs avg', valueOr(result.concurrency.averageJobs, 0)],
        ['jobs peak', valueOr(result.concurrency.peakJobs, 0)],
        ['HTTP avg', valueOr(result.concurrency.averageHttpRequests, 0)],
        ['HTTP peak', valueOr(result.concurrency.peakHttpRequests, 0)],
      ],
      'concurrency',
    ),
    proxy: groupedBars(
      'Raw proxies by constraint',
      result.proxy.constraints.map((constraint) => [
        constraint.kind,
        valueOr(constraint.rawProxies, 0),
      ]),
      'proxy',
    ),
    growth: lineChart(
      'Monthly logical jobs/day',
      result.growth.map((month) => month.logicalJobsPerDay),
      'growth',
    ),
  };
}

function lineChart(title: string, rawValues: readonly number[], name: string): string {
  const values = rawValues.map(finite);
  if (values.length === 0) return emptyChart(title, name);
  const width = 640;
  const height = 210;
  const left = 42;
  const top = 18;
  const plotWidth = width - left - 18;
  const plotHeight = height - top - 32;
  const max = Math.max(1, ...values);
  const denominator = Math.max(1, values.length - 1);
  const points = values
    .map((value, index) => {
      const x = left + (index / denominator) * plotWidth;
      const y = top + plotHeight - (value / max) * plotHeight;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
  return `<svg data-capacity-chart="${name}" viewBox="0 0 ${String(width)} ${String(height)}" role="img" aria-label="${escapeHtml(title)}">
    <title>${escapeHtml(title)}</title>
    <line x1="${String(left)}" y1="${String(top + plotHeight)}" x2="${String(width - 18)}" y2="${String(top + plotHeight)}" class="chart-axis" />
    <polyline points="${points}" class="chart-line" />
    <text x="${String(left)}" y="${String(height - 8)}" class="chart-label">1</text>
    <text x="${String(width - 32)}" y="${String(height - 8)}" class="chart-label">${String(rawValues.length)}</text>
    <text x="4" y="${String(top + 5)}" class="chart-label">${compact(max)}</text>
  </svg>`;
}

function groupedBars(
  title: string,
  rawEntries: readonly (readonly [string, number])[],
  name: string,
): string {
  const entries = rawEntries.map(([label, value]) => [label, finite(value)] as const);
  if (entries.length === 0) return emptyChart(title, name);
  const width = 640;
  const height = 210;
  const max = Math.max(1, ...entries.map((entry) => entry[1]));
  const slot = 580 / entries.length;
  const bars = entries
    .map(([label, value], index) => {
      const barHeight = (value / max) * 135;
      const x = 44 + index * slot + slot * 0.18;
      const y = 166 - barHeight;
      const barWidth = slot * 0.64;
      return `<g><rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${barHeight.toFixed(2)}" rx="4" class="chart-bar" />
        <text x="${(x + barWidth / 2).toFixed(2)}" y="181" text-anchor="middle" class="chart-label">${escapeHtml(shortLabel(label))}</text>
        <text x="${(x + barWidth / 2).toFixed(2)}" y="${Math.max(14, y - 5).toFixed(2)}" text-anchor="middle" class="chart-value">${compact(value)}</text></g>`;
    })
    .join('');
  return `<svg data-capacity-chart="${name}" viewBox="0 0 ${String(width)} ${String(height)}" role="img" aria-label="${escapeHtml(title)}"><title>${escapeHtml(title)}</title>${bars}</svg>`;
}

function emptyChart(title: string, name: string): string {
  return `<svg data-capacity-chart="${name}" viewBox="0 0 640 210" role="img" aria-label="${escapeHtml(title)}"><title>${escapeHtml(title)}</title><text x="320" y="105" text-anchor="middle" class="chart-label">No data</text></svg>`;
}

function sample<T>(values: readonly T[], limit: number): readonly T[] {
  if (values.length <= limit) return values;
  const stride = (values.length - 1) / (limit - 1);
  return Array.from({ length: limit }, (_, index) => values[Math.round(index * stride)] as T);
}

function finite(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function compact(value: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(
    finite(value),
  );
}

function shortLabel(value: string): string {
  return value.replace('monthly-', '').replace('job-', 'job ').slice(0, 16);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
