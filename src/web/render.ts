import { type RecentResultDto, type RunState } from '../app/types.js';
import { summarizeFailureConcentration } from '../core/metrics/proxy-insights.js';
import { type ThroughputSample } from '../core/metrics/throughput-timeline.js';
import { type ScrapeStatus } from '../core/models/status.js';
import { type ProxyHealth, type ProxyState } from '../core/scraper/pool-ports.js';
import { type ProxyProbeStage, type ProxySourceStats } from '../core/scraper/proxy-source-ports.js';
import { formatDuration } from '../core/schedule/duration.js';

import {
  METRIC_LABELS,
  formatBytes,
  formatClock,
  formatCompact,
  formatDelta,
  formatExact,
  formatTimestamp,
  toPlotPoints,
  type MetricPlotPoint,
} from './metric-format.js';
import { isRunActive, type AppState } from './state.js';

/**
 * DOM rendering.
 *
 * Every function here takes the whole state and writes to the DOM. No virtual
 * DOM, no bindings — the dashboard is small enough that a full re-render on
 * each change is both fast and easy to reason about.
 */

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) {
    throw new Error(`missing element #${id}`);
  }
  return node as T;
}

const STATE_STYLES: Record<RunState, string> = {
  idle: 'border-slate-700 bg-slate-800/50 text-slate-400',
  preparing: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  running: 'border-sky-500/40 bg-sky-500/10 text-sky-300',
  waiting: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  completed: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  failed: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
};

/**
 * Severity colours, deliberately not the same palette as run status: a cooling
 * proxy is a normal, self-healing condition, while a retired one will not come
 * back without someone doing something about it.
 */
const PROXY_STATE_STYLES: Record<ProxyState, string> = {
  healthy: 'bg-emerald-500/15 text-emerald-300',
  saturated: 'bg-sky-500/15 text-sky-300',
  probation: 'bg-amber-500/15 text-amber-300',
  untested: 'bg-slate-500/15 text-slate-300',
  cooling: 'bg-orange-500/15 text-orange-300',
  retired: 'bg-rose-500/15 text-rose-300',
};

/** Worst first, so the row that explains a bad run is never below the fold. */
const PROXY_STATE_ORDER: Record<ProxyState, number> = {
  retired: 0,
  cooling: 1,
  probation: 2,
  untested: 3,
  saturated: 4,
  healthy: 5,
};

const STATUS_STYLES: Record<ScrapeStatus, string> = {
  ok: 'bg-emerald-500/15 text-emerald-300',
  not_found: 'bg-slate-500/15 text-slate-300',
  private: 'bg-violet-500/15 text-violet-300',
  rate_limited: 'bg-amber-500/15 text-amber-300',
  error: 'bg-rose-500/15 text-rose-300',
};

export function render(state: AppState): void {
  renderControls(state);
  renderStateBadge(state);
  renderError(state);
  renderProgress(state);
  renderThroughputChart(state);
  renderMetricSeriesChart(state);
  renderProxyPanel(state);
  renderBandwidthPanel(state);
  renderResults(state);
  renderInputReport(state);
  renderSummary(state);
  renderDefaults(state);
}

function renderControls(state: AppState): void {
  const active = isRunActive(state.status);

  for (const id of [
    'platform',
    'input-text',
    'input-file',
    'concurrency',
    'target-rpm',
    'continuous',
    'interval',
    'duration',
    'max-cycles',
  ]) {
    const node = document.getElementById(id);
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
      node.disabled = active;
    } else if (node instanceof HTMLSelectElement) {
      node.disabled = active;
    }
  }

  const start = el<HTMLButtonElement>('start-button');
  start.disabled = active;

  const cancel = el<HTMLButtonElement>('cancel-button');
  cancel.classList.toggle('hidden', !active);

  for (const button of document.querySelectorAll<HTMLButtonElement>('.input-method-btn')) {
    button.disabled = active;
    button.dataset['active'] = String(button.dataset['method'] === state.inputMethod);
  }

  el('paste-panel').classList.toggle('hidden', state.inputMethod !== 'paste');
  el('file-panel').classList.toggle('hidden', state.inputMethod !== 'file');
  el('file-name').textContent =
    state.fileName === null ? '' : `${state.fileName} — parsed as ${state.format}`;

  const download = el<HTMLButtonElement>('download-button');
  download.classList.toggle('hidden', !state.hasOutput || state.runId === null);

  const sessionDownload = el<HTMLButtonElement>('session-button');
  sessionDownload.classList.toggle('hidden', state.sessionSummary === null);

  // The schedule fields only mean something in continuous mode, and dimming
  // them says so more clearly than leaving them live but ignored.
  const scheduleDisabled = active || !state.continuous;
  for (const id of ['interval', 'duration', 'max-cycles']) {
    const node = document.getElementById(id);
    if (node instanceof HTMLInputElement) node.disabled = scheduleDisabled;
  }
  el('schedule-fields').classList.toggle('opacity-40', !state.continuous);

  const continuous = el<HTMLInputElement>('continuous');
  continuous.checked = state.continuous;
  continuous.disabled = active;

  start.textContent = active
    ? state.status === 'waiting'
      ? 'Waiting…'
      : 'Running…'
    : state.continuous
      ? 'Start session'
      : 'Start run';
}

function renderStateBadge(state: AppState): void {
  const badge = el('state-badge');
  badge.className =
    'rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wide ' +
    STATE_STYLES[state.status];
  badge.textContent = state.status;
}

function renderError(state: AppState): void {
  const panel = el('error-panel');
  if (state.error === null) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
    return;
  }

  panel.classList.remove('hidden');
  panel.className =
    'mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200';
  panel.innerHTML = `<div class="font-semibold">${escapeHtml(state.error.code)}</div>
    <div class="mt-1 text-rose-200/90">${escapeHtml(state.error.message)}</div>`;
}

function renderProgress(state: AppState): void {
  const wrap = el('progress-bar-wrap');
  const bar = el('progress-bar');
  const stats = el('progress-stats');
  const progress = state.progress;

  if (progress === null) {
    wrap.classList.add('hidden');
    stats.innerHTML = statCards([
      ['Processed', '—'],
      ['Successful', '—'],
      ['Failed', '—'],
      ['Throughput', '—'],
      ['Elapsed', '—'],
    ]);
    return;
  }

  wrap.classList.remove('hidden');
  const pct = progress.total === 0 ? 0 : (progress.processed / progress.total) * 100;
  bar.style.width = `${pct.toFixed(1)}%`;

  const cards: (readonly [string, string])[] = [
    ['Processed', `${progress.processed} / ${progress.total}`],
    ['Successful', String(progress.successful)],
    ['Failed', String(progress.failed)],
    // Instantaneous during a session, cumulative for a one-shot run — either
    // way, whatever the backend just measured.
    ['Throughput', `${progress.throughputPerMinute.toFixed(0)}/min`],
    ['Elapsed', formatDuration(progress.elapsedMs)],
    ['In flight', String(progress.inFlight)],
  ];

  if (state.continuous) {
    const peak = state.timeline.reduce((best, s) => Math.max(best, s.requestsPerMinute), 0);
    const sustained = sustainedMs(state.timeline, state.targetRpm);

    cards.push([
      'Cycle',
      state.cycle === null
        ? '—'
        : `${state.cycle.current}${state.cycle.planned === null ? '' : ` / ${state.cycle.planned}`}`,
    ]);
    cards.push(['Peak', `${peak.toFixed(0)}/min`]);
    cards.push(['Held >= target', sustained === 0 ? '—' : formatDuration(sustained)]);
    cards.push([
      state.sessionSummary === null ? 'Next cycle' : 'Stopped',
      state.sessionSummary === null
        ? nextCycleLabel(state)
        : state.sessionSummary.schedule.stop_reason,
    ]);
  } else {
    cards.push(['Queued', String(progress.queued)]);
  }

  stats.innerHTML = statCards(cards);
}

/** Longest contiguous stretch at or above target, mirroring `ThroughputTimeline.sustained`. */
function sustainedMs(samples: readonly ThroughputSample[], target: number): number {
  if (target <= 0) return 0;
  let best = 0;
  let startMs: number | null = null;
  let previousMs = 0;

  for (const sample of samples) {
    if (sample.requestsPerMinute >= target) {
      startMs ??= previousMs;
      best = Math.max(best, sample.tMs - startMs);
    } else {
      startMs = null;
    }
    previousMs = sample.tMs;
  }
  return best;
}

function nextCycleLabel(state: AppState): string {
  if (state.status !== 'waiting') return state.status === 'running' ? 'running' : '—';
  const next = state.cycle?.nextStartsAt;
  if (next === undefined || next === null) return 'soon';
  const remaining = new Date(next).getTime() - Date.now();
  return remaining <= 0 ? 'now' : formatDuration(remaining);
}

/**
 * Live proxy pool.
 *
 * The operational question this answers is "is the pool the reason this run
 * looks worse than the last one", so the shape is: how much usable capacity is
 * there right now, and is anything concentrated. Cooldown countdowns are
 * computed at render time — the run poll re-renders several times a second, so
 * they tick without a timer of their own.
 */
function renderProxyPanel(state: AppState): void {
  const panel = el('proxy-panel');
  const pool = state.proxies;

  // A dynamically sourced pool is briefly empty while the first candidates are
  // being validated, and hiding the panel exactly then would hide the thing the
  // operator most wants to watch.
  if (pool === null || (pool.configured === 0 && pool.source === null)) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
    return;
  }

  panel.classList.remove('hidden');
  const now = Date.now();
  const proxies = [...pool.perProxy].sort(
    (a, b) => PROXY_STATE_ORDER[a.state] - PROXY_STATE_ORDER[b.state] || b.failures - a.failures,
  );
  const concentration = summarizeFailureConcentration(
    pool.perProxy.map((proxy) => ({
      proxy_id: proxy.id,
      label: proxy.label,
      failures: proxy.failures,
    })),
  );

  panel.innerHTML = `
    <h2 class="mb-4 text-sm font-semibold uppercase tracking-wider text-slate-400">Proxy pool</h2>
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      ${statCards([
        ['Configured', String(pool.configured)],
        ['Usable', String(pool.available)],
        ['Cooling', String(pool.cooling)],
        ['Retired', String(pool.retired)],
        ['Jobs in flight', `${pool.totalInFlight} on ${pool.inUse}`],
        ['Capacity', pool.capacity === null ? 'unlimited' : String(pool.capacity)],
      ])}
    </div>
    ${
      pool.poolExhaustedCount > 0
        ? `<p class="mt-3 rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
             The whole pool was blocked or cooling ${pool.poolExhaustedCount} time(s). Jobs failed
             for want of a usable proxy, not because of the platform.
           </p>`
        : ''
    }
    ${pool.source === null ? '' : proxySourceLine(pool.source)}
    ${
      concentration.concentrated
        ? `<p class="mt-3 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
             ${(concentration.topShare * 100).toFixed(0)}% of proxy failures are on
             ${escapeHtml(concentration.worst.map((proxy) => proxy.label).join(' and '))}.
             The rest of the pool is carrying its share.
           </p>`
        : ''
    }
    <div class="mt-4 overflow-x-auto">
      <table class="w-full min-w-[720px] text-left text-xs">
        <thead class="text-slate-500">
          <tr>
            <th class="pb-2 pr-3 font-medium">Proxy</th>
            <th class="pb-2 pr-3 font-medium">State</th>
            <th class="pb-2 pr-3 font-medium">In flight</th>
            <th class="pb-2 pr-3 font-medium text-right">Req</th>
            <th class="pb-2 pr-3 font-medium text-right">OK</th>
            <th class="pb-2 pr-3 font-medium text-right">Fail</th>
            <th class="pb-2 pr-3 font-medium">Detail</th>
          </tr>
        </thead>
        <tbody class="font-mono">
          ${proxies.map((proxy) => proxyRow(proxy, now)).join('')}
        </tbody>
      </table>
    </div>`;
}

/**
 * Where the pool's capacity is coming from.
 *
 * Sits above the per-proxy table because with a live source the interesting
 * question moves up a level: not "is p7 healthy" but "is the supply keeping up
 * with what the pool is burning".
 */
function proxySourceLine(source: ProxySourceStats): string {
  const failed = source.refreshFailures > 0;
  return `<p class="mt-3 rounded border ${
    failed
      ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
      : 'border-slate-800 bg-slate-950/40 text-slate-400'
  } px-3 py-2 text-xs">
      <span class="font-semibold">Source: ${escapeHtml(source.name)}</span>
      — ${source.candidates.toLocaleString()} candidate(s),
      ${source.validating} validating,
      ${source.admitted} admitted,
      ${source.rejected} rejected,
      target ${source.targetCapacity} slots.
      Probes: ${source.probeSuccesses} passed / ${source.probeFailures} failed
      (${probeStageBreakdown(source)}).
      Admitted ${source.admittedTotal}, tried ${source.admittedTried},
      of which ${source.admittedProven} ever succeeded${
        source.admissionToFirstSuccessRate === null
          ? ''
          : ` — ${(source.admissionToFirstSuccessRate * 100).toFixed(0)}%`
      }.
      ${
        source.lastRefreshError === null
          ? ''
          : `Last refresh failed: ${escapeHtml(source.lastRefreshError)}.`
      }
    </p>`;
}

/**
 * Which layer is doing the rejecting, in the order a probe meets them.
 *
 * Named rather than numbered because the names are the diagnosis: a run
 * failing mostly at `tunnel` is being fed hosts that are not proxies, and one
 * failing at `tls` is being intercepted. Empty stages are dropped so the line
 * stays short on a healthy run.
 */
function probeStageBreakdown(source: ProxySourceStats): string {
  const stages: readonly ProxyProbeStage[] = ['connect', 'tunnel', 'tls', 'response'];
  const parts = stages
    .filter((stage) => source.probeFailuresByStage[stage] > 0)
    .map((stage) => `${stage} ${source.probeFailuresByStage[stage]}`);
  return parts.length === 0 ? 'no failures' : parts.join(', ');
}

function proxyRow(proxy: ProxyHealth, now: number): string {
  return `<tr class="border-t border-slate-800/70">
      <td class="py-1.5 pr-3">
        <span class="text-slate-300">${escapeHtml(proxy.label)}</span>
        <span class="text-slate-500">${escapeHtml(proxy.id)}</span>
        ${
          proxy.source === 'config'
            ? ''
            : `<span class="ml-1 rounded bg-slate-800 px-1 text-[10px] text-slate-400">${escapeHtml(proxy.source)}</span>`
        }
      </td>
      <td class="py-1.5 pr-3">
        <span class="rounded px-1.5 py-0.5 text-[11px] ${PROXY_STATE_STYLES[proxy.state]}">
          ${proxy.state}
        </span>
      </td>
      <td class="py-1.5 pr-3 text-slate-300">
        ${proxy.inFlight}${proxy.capacity === null ? '' : ` / ${proxy.capacity}`}
      </td>
      <td class="py-1.5 pr-3 text-right text-slate-300">${proxy.requests}</td>
      <td class="py-1.5 pr-3 text-right text-emerald-300">${proxy.successes}</td>
      <td class="py-1.5 pr-3 text-right ${proxy.failures > 0 ? 'text-rose-300' : 'text-slate-500'}">
        ${proxy.failures}
      </td>
      <td class="py-1.5 pr-3 text-slate-400">${escapeHtml(proxyDetail(proxy, now))}</td>
    </tr>`;
}

/** The one thing worth knowing about this proxy right now. */
function proxyDetail(proxy: ProxyHealth, now: number): string {
  if (proxy.state === 'retired') {
    const since =
      proxy.unhealthySince === null ? '' : ` ${formatDuration(now - proxy.unhealthySince)} ago`;
    return `unsuitable exit node — retired${since}`;
  }
  if (proxy.state === 'cooling') {
    const back =
      proxy.eligibleAt === null
        ? 'held out of rotation'
        : `back in ${formatDuration(Math.max(0, proxy.eligibleAt - now))}`;
    const why = proxy.lastErrorCode === null ? '' : ` after ${proxy.lastErrorCode}`;
    return `${back}${why}`;
  }
  if (proxy.state === 'untested') return 'never used yet';
  if (proxy.state === 'probation') {
    return `on probation${proxy.lastErrorCode === null ? '' : ` after ${proxy.lastErrorCode}`}`;
  }
  if (proxy.lastSuccessAt !== null) {
    return `last ok ${formatDuration(Math.max(0, now - proxy.lastSuccessAt))} ago`;
  }
  return '';
}

// --- bandwidth ---------------------------------------------------------

/**
 * This run's wire bytes against the cross-run baseline, plus a small live
 * sparkline.
 *
 * `state.bandwidth` is `null` whenever `METRICS_BANDWIDTH` is off or nothing
 * has *ever* been measured — never a synthetic zero (see `BandwidthView`,
 * `ThroughputSample.bytes`) — and the whole panel is gated on that.
 *
 * A second, narrower gate covers `current.bytesPerRequest === null`: this
 * run measured nothing (zero wire requests), but the baseline and
 * "average of all" sections below are cross-run history that does not depend
 * on this run at all, so only the "this run" line and the sparkline are
 * suppressed, not the whole panel (Minor #2) — a continuous session's prior
 * history must stay visible even on a cycle that measured nothing.
 *
 * R5: a live sample's `bytes`/`bytesPerMinute` are fed `?? 0` when the run's
 * bandwidth aggregator is absent, so a series drawn from an unmeasured run
 * would otherwise render a flat, false "zero bandwidth" line. The sparkline
 * is gated on `bytesPerRequest === null` exactly like the "this run" line,
 * never on whether a figure happens to look like zero, so an unmeasured run
 * still draws no line at all.
 */
function renderBandwidthPanel(state: AppState): void {
  const panel = el('bandwidth-panel');
  const data = state.bandwidth;

  // Gated on `state.bandwidth` alone: the baseline and "average of all"
  // sections below draw from cross-run history, not from this run, so a run
  // that measured nothing must not hide history that is still informative
  // (Minor #2). Only the "this run" line and the sparkline — both of which
  // *do* depend on the current run — are gated further below, on
  // `bytesPerRequest === null`.
  if (data === null) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
    return;
  }

  panel.classList.remove('hidden');
  const { current, baseline } = data;
  // Bound to a local so the null check below narrows it for the rest of the
  // function — TS does not carry a `data.current.bytesPerRequest !== null`
  // guard across a destructure into `current.bytesPerRequest`.
  const bytesPerRequest = current.bytesPerRequest;

  // R5 (kept): a run that measured nothing this time (zero wire requests)
  // must not claim a "this run" figure or draw the live sparkline — either
  // would read as a real, if tiny, measurement rather than an absence of one.
  const thisRunLine =
    bytesPerRequest === null
      ? ''
      : `<div class="flex justify-between">
          <dt>this run</dt>
          <dd class="text-slate-200">
            ${formatBytes(current.totalBytes)} over ${current.requests} reqs
            &middot; ${formatBytes(bytesPerRequest)}/req
          </dd>
        </div>`;

  const drift =
    bytesPerRequest === null ||
    baseline.baseline === null ||
    baseline.baseline.avgBytesPerRequest === 0
      ? null
      : (bytesPerRequest / baseline.baseline.avgBytesPerRequest - 1) * 100;

  panel.innerHTML = `
    <h2 class="mb-1 text-sm font-semibold uppercase tracking-wider text-slate-400">Bandwidth</h2>
    <dl class="mt-3 space-y-1.5 text-xs text-slate-400">
      ${thisRunLine}
      <div class="flex justify-between">
        <dt>baseline</dt>
        <dd class="text-slate-200">
          ${
            baseline.baseline === null
              ? '<span class="text-slate-500">no previous run</span>'
              : `${formatBytes(baseline.baseline.avgBytesPerRequest)}/req` +
                (drift === null
                  ? ''
                  : ` <span class="${driftClass(drift)}">${formatDrift(drift)}</span>`)
          }
        </dd>
      </div>
    </dl>
    ${bytesPerRequest === null ? '' : renderBandwidthSparkline(state)}
    <h3 class="mt-4 border-t border-slate-800 pt-3 text-xs font-semibold text-slate-300">
      average of all
    </h3>
    <dl class="mt-2 space-y-1.5 text-xs text-slate-400">
      <div class="flex justify-between">
        <dt>by request</dt>
        <dd class="text-slate-200">
          ${baseline.byRequest === null ? '—' : `${formatBytes(baseline.byRequest)}/req`}
        </dd>
      </div>
      <div class="flex justify-between">
        <dt>by run</dt>
        <dd class="text-slate-200">
          ${baseline.byRun === null ? '—' : `${formatBytes(baseline.byRun)}/req`}
          <span class="text-slate-500">(${baseline.runs} runs)</span>
        </dd>
      </div>
    </dl>
  `;
}

function formatDrift(percent: number): string {
  const arrow = percent >= 0 ? '▲' : '▼';
  return `${arrow} ${percent >= 0 ? '+' : ''}${percent.toFixed(0)}%`;
}

function driftClass(percent: number): string {
  return percent > 0 ? 'text-amber-400' : 'text-emerald-400';
}

/**
 * Small live-bandwidth sparkline, on its own scale.
 *
 * Deliberately not a series on the shared-axis throughput chart: bytes per
 * minute for a TikTok scrape (hundreds of KB/min) dwarfs request rate
 * (tens/min), so sharing the axis would flatten one series or the other. Only
 * ever called from inside `renderBandwidthPanel`, behind its own
 * `bytesPerRequest === null` gate — so this can never draw a line for a run
 * that measured nothing (R5).
 */
function renderBandwidthSparkline(state: AppState): string {
  const samples = state.timeline;
  if (samples.length < 2) return '';

  const peak = samples.reduce((best, s) => Math.max(best, s.bytesPerMinute), 0);
  if (peak <= 0) return '';

  const width = 260;
  const height = 40;
  const firstMs = samples[0]?.tMs ?? 0;
  const lastMs = samples[samples.length - 1]?.tMs ?? firstMs;
  const spanMs = Math.max(1, lastMs - firstMs);

  const points = samples.map(
    (s) =>
      [((s.tMs - firstMs) / spanMs) * width, height - (s.bytesPerMinute / peak) * height] as const,
  );

  return `
    <div class="mt-3">
      <div class="mb-1 text-[10px] uppercase tracking-wider text-slate-500">live bandwidth</div>
      <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}"
           role="img" aria-label="Bandwidth over time">
        <path d="${pathFrom(points)}" fill="none" stroke="currentColor" class="text-violet-400"
              stroke-width="1.5" stroke-linejoin="round" />
      </svg>
    </div>`;
}

function renderResults(state: AppState): void {
  const container = el('results');

  if (state.recentResults.length === 0) {
    container.innerHTML = `<p class="py-6 text-center text-sm text-slate-500">
      ${state.status === 'idle' ? 'No run yet.' : 'Waiting for the first result…'}
    </p>`;
    return;
  }

  container.innerHTML = `<table class="w-full text-left text-xs">
      <thead class="sticky top-0 bg-slate-900 text-[11px] uppercase tracking-wider text-slate-500">
        <tr>
          <th class="px-2 py-2 font-medium">Status</th>
          <th class="px-2 py-2 font-medium">URL</th>
          <th class="px-2 py-2 text-right font-medium">Latency</th>
          <th class="px-2 py-2 text-right font-medium">Attempts</th>
          <th class="px-2 py-2 text-right font-medium">Time</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-slate-800/70">
        ${state.recentResults.map(resultRow).join('')}
      </tbody>
    </table>`;
}

function resultRow(result: RecentResultDto): string {
  return `<tr>
    <td class="px-2 py-2 align-top">
      <span class="rounded px-1.5 py-0.5 font-medium ${STATUS_STYLES[result.status]}">
        ${escapeHtml(result.status)}
      </span>
    </td>
    <td class="px-2 py-2 align-top">
      <div class="max-w-md truncate font-mono text-slate-300" title="${escapeHtml(result.url)}">
        ${escapeHtml(result.url)}
      </div>
      ${
        result.error === null
          ? ''
          : `<div class="mt-0.5 max-w-md truncate text-rose-300/80" title="${escapeHtml(result.error)}">${escapeHtml(result.error)}</div>`
      }
    </td>
    <td class="px-2 py-2 text-right align-top font-mono text-slate-400">${result.latencyMs} ms</td>
    <td class="px-2 py-2 text-right align-top font-mono text-slate-400">${result.attempts}</td>
    <td class="px-2 py-2 text-right align-top font-mono text-slate-500"
        title="${escapeHtml(result.scrapedAt)}">${escapeHtml(formatClock(Date.parse(result.scrapedAt)))}</td>
  </tr>`;
}

function renderInputReport(state: AppState): void {
  const panel = el('input-report');
  const report = state.input;

  if (report === null || report.issues.length === 0) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
    return;
  }

  panel.classList.remove('hidden');
  panel.innerHTML = `
    <h2 class="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-400">
      Rejected input (${report.rejected} of ${report.candidates})
    </h2>
    <ul class="space-y-1.5 text-xs">
      ${report.issues
        .slice(0, 50)
        .map(
          (issue) => `<li class="flex gap-2">
            <span class="rounded bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-300">
              ${escapeHtml(issue.code)}
            </span>
            <span class="text-slate-400">
              ${issue.position === null ? '' : `position ${issue.position}: `}${escapeHtml(issue.message)}
            </span>
          </li>`,
        )
        .join('')}
    </ul>`;
}

function renderSummary(state: AppState): void {
  const panel = el('summary');
  const summary = state.summary;

  if (summary === null) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
    return;
  }

  panel.classList.remove('hidden');

  const statuses = Object.entries(summary.status_breakdown).filter(([, count]) => count > 0);
  const proxies = summary.proxies;
  const concurrency = summary.throughput.concurrency;
  // Capacity was available and demanded, but never used — the fingerprint of
  // accidental serialization. Showing the configured number alone would hide it.
  const underused =
    concurrency.max_observed < concurrency.configured && summary.queue.max_depth > 0;

  panel.innerHTML = `
    <h2 class="mb-4 text-sm font-semibold uppercase tracking-wider text-slate-400">Run summary</h2>
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      ${statCards([
        ['Success rate', `${(summary.totals.success_rate * 100).toFixed(1)}%`],
        ['Throughput', `${summary.throughput.requests_per_minute.toFixed(1)}/min`],
        ['Concurrency', `${concurrency.max_observed} / ${concurrency.configured}`],
        ['Effective', `${concurrency.effective.toFixed(2)}x`],
        ['p50', formatMs(summary.latency.p50_ms)],
        ['p95', formatMs(summary.latency.p95_ms)],
        ['max', formatMs(summary.latency.max_ms)],
        ['Requests', String(summary.totals.requests)],
        ['Failures', String(summary.totals.failures)],
        ['Retries', String(summary.retries.total_retries)],
        ['Rows written', String(summary.output.rows_written)],
        ['Duration', `${(summary.duration_ms / 1000).toFixed(1)}s`],
      ])}
    </div>
    ${
      underused
        ? `<p class="mt-3 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
             Concurrency underused: ${concurrency.configured} configured,
             ${concurrency.max_observed} observed, queue backlog peaked at
             ${summary.queue.max_depth}. Effective concurrency
             ${concurrency.effective.toFixed(2)}x.
           </p>`
        : ''
    }

    <div class="mt-5 grid gap-5 sm:grid-cols-2">
      <div>
        <h3 class="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
          Queue delay (enqueue to job start)
        </h3>
        ${statCards([
          ['Count', String(summary.queue.wait_count)],
          ['Mean', formatMs(summary.queue.wait_mean_ms)],
          ['p95', formatMs(summary.queue.wait_p95_ms)],
          ['Max', formatMs(summary.queue.wait_max_ms)],
        ])}
      </div>
      <div>
        <h3 class="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
          Aggregate waits (aggregate job-time; may overlap)
        </h3>
        ${statCards([
          ['Admission', formatMs(summary.waits.admission_total_ms)],
          ['HTTP limiter', formatMs(summary.waits.http_rate_limit_total_ms)],
          ['Proxy acquire', formatMs(summary.waits.proxy_acquire_total_ms)],
          ['Retry backoff', formatMs(summary.waits.retry_backoff_total_ms)],
        ])}
      </div>
    </div>

    <div class="mt-5 grid gap-5 sm:grid-cols-2">
      <div>
        <h3 class="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
          Status breakdown
        </h3>
        <ul class="space-y-1 text-xs">
          ${statuses
            .map(
              ([status, count]) =>
                `<li class="flex justify-between gap-3 font-mono">
                   <span class="text-slate-400">${escapeHtml(status)}</span>
                   <span class="text-slate-200">${count}</span>
                 </li>`,
            )
            .join('')}
        </ul>
      </div>
      <div>
        <h3 class="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
          Proxy statistics
        </h3>
        ${
          proxies.configured === 0
            ? '<p class="text-xs text-slate-500">No proxies configured — requests went out directly.</p>'
            : `<ul class="space-y-1 text-xs font-mono">
                 <li class="flex justify-between gap-3"><span class="text-slate-400">configured</span><span>${proxies.configured}</span></li>
                 <li class="flex justify-between gap-3"><span class="text-slate-400">used</span><span>${proxies.used}</span></li>
                 <li class="flex justify-between gap-3"><span class="text-slate-400">blocked</span><span>${proxies.blocked}</span></li>
                 <li class="flex justify-between gap-3"><span class="text-slate-400">failures</span><span>${proxies.total_failures}</span></li>
               </ul>`
        }
      </div>
    </div>

    <p class="mt-4 border-t border-slate-800 pt-3 font-mono text-[11px] text-slate-500">
      ${escapeHtml(summary.output.snapshots_path ?? 'no output file')}
    </p>`;
}

function renderDefaults(state: AppState): void {
  const list = el('defaults');
  const defaults = state.defaults;

  if (defaults === null) {
    list.innerHTML = '<p class="text-slate-500">Loading configuration…</p>';
    return;
  }

  const rows: [string, string][] = [
    ['Output directory', defaults.outputDir],
    ['Max attempts', String(defaults.maxAttempts)],
    ['Proxies configured', String(defaults.proxiesConfigured)],
    ['Session store', defaults.sessionsConfigured ? 'configured' : 'none (anonymous)'],
    [
      'Scrapers implemented',
      defaults.scrapersImplemented.length === 0
        ? 'none yet'
        : defaults.scrapersImplemented.join(', '),
    ],
  ];

  list.innerHTML = rows
    .map(
      ([label, value]) =>
        `<div class="flex justify-between gap-3">
           <dt class="text-slate-500">${escapeHtml(label)}</dt>
           <dd class="font-mono text-slate-300">${escapeHtml(value)}</dd>
         </div>`,
    )
    .join('');
}

function statCards(entries: readonly (readonly [string, string])[]): string {
  return entries
    .map(
      ([label, value]) =>
        `<div class="stat-card">
           <div class="stat-label">${escapeHtml(label)}</div>
           <div class="stat-value">${escapeHtml(value)}</div>
         </div>`,
    )
    .join('');
}

function formatMs(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)} ms`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- throughput chart -------------------------------------------------------

const CHART = {
  width: 820,
  height: 260,
  padLeft: 52,
  padRight: 16,
  padTop: 16,
  padBottom: 30,
} as const;

/**
 * Rounds an axis maximum up to something a human would have chosen.
 *
 * The steps are deliberately fine-grained and all divide cleanly by four, so
 * the quarter gridlines land on round numbers and a peak of 540 gets a 600
 * axis rather than being squashed into the bottom half of a 1000 one.
 */
const AXIS_STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10] as const;

function niceCeiling(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = AXIS_STEPS.find((candidate) => normalized <= candidate) ?? 10;
  return step * magnitude;
}

/**
 * Caps how many points reach the SVG.
 *
 * A long session retains thousands of samples, and a path with one node per
 * pixel-eighth is both slow to draw and no more informative. Peaks are kept
 * rather than averaged: this chart exists to show the extremes.
 */
const MAX_PLOTTED_POINTS = 400;

function downsample(samples: readonly ThroughputSample[]): readonly ThroughputSample[] {
  if (samples.length <= MAX_PLOTTED_POINTS) return samples;

  const bucketSize = Math.ceil(samples.length / MAX_PLOTTED_POINTS);
  const output: ThroughputSample[] = [];

  for (let start = 0; start < samples.length; start += bucketSize) {
    const bucket = samples.slice(start, start + bucketSize);
    let peak = bucket[0];
    for (const sample of bucket) {
      if (peak === undefined || sample.requestsPerMinute > peak.requestsPerMinute) peak = sample;
    }
    if (peak !== undefined) output.push(peak);
  }

  // Always keep the newest sample so the line reaches the right-hand edge.
  const newest = samples[samples.length - 1];
  if (newest !== undefined && output[output.length - 1] !== newest) output.push(newest);

  return output;
}

function pathFrom(points: readonly (readonly [number, number])[]): string {
  return points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x} ${y}`).join(' ');
}

/**
 * Throughput over time, as inline SVG.
 *
 * Hand-rolled rather than pulling in a chart library: the dashboard is a dev
 * tool with no frontend framework, and one chart does not justify a dependency.
 *
 * The series is *instantaneous* rate — derived from the delta between samples,
 * not the cumulative average — because a soak test exists to reveal dips, and a
 * running average smooths exactly those away. Retries are drawn as a separate
 * dotted line so they can never be misread as throughput.
 */
function renderThroughputChart(state: AppState): void {
  const panel = el('throughput-panel');
  const container = el('throughput-chart');

  // The chart is only meaningful for a continuous session; a one-shot run is
  // over before it has enough samples to say anything.
  if (!state.continuous && state.timeline.length === 0) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');

  const samples = downsample(state.timeline);
  if (samples.length < 2) {
    container.innerHTML = `<p class="py-12 text-center text-sm text-slate-500">
      ${state.status === 'idle' ? 'No session yet.' : 'Collecting samples…'}
    </p>`;
    return;
  }

  const { width, height, padLeft, padRight, padTop, padBottom } = CHART;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;

  const target = state.targetRpm;
  // Over the full series, not the downsampled one — the axis must contain
  // every observed peak even if that sample was dropped from the path.
  const peak = state.timeline.reduce((best, s) => Math.max(best, s.requestsPerMinute), 0);
  // Modest headroom; `niceCeiling` supplies the rest of the padding.
  const yMax = niceCeiling(Math.max(peak, target) * 1.05);

  const firstMs = samples[0]?.tMs ?? 0;
  const lastMs = samples[samples.length - 1]?.tMs ?? firstMs;
  const spanMs = Math.max(1, lastMs - firstMs);

  const x = (sample: ThroughputSample): number =>
    padLeft + ((sample.tMs - firstMs) / spanMs) * plotWidth;
  const y = (value: number): number => padTop + plotHeight - (value / yMax) * plotHeight;

  // Stacked areas: failures sit on the baseline, successes ride on top, so the
  // combined height is total throughput and the split stays readable.
  const baseline = padTop + plotHeight;
  const failureTop = samples.map((s): readonly [number, number] => [x(s), y(s.failuresPerMinute)]);
  const successTop = samples.map((s): readonly [number, number] => [
    x(s),
    y(s.failuresPerMinute + s.successesPerMinute),
  ]);

  const area = (top: readonly (readonly [number, number])[], from: number): string => {
    const firstX = top[0]?.[0] ?? padLeft;
    const lastX = top[top.length - 1]?.[0] ?? padLeft;
    return `${pathFrom(top)} L${lastX} ${from} L${firstX} ${from} Z`;
  };

  const totalLine = pathFrom(samples.map((s) => [x(s), y(s.requestsPerMinute)] as const));
  const retryLine = pathFrom(samples.map((s) => [x(s), y(s.retriesPerMinute)] as const));

  const gridValues = [0, 0.25, 0.5, 0.75, 1].map((fraction) => fraction * yMax);
  const gridlines = gridValues
    .map((value) => {
      const gy = y(value);
      return `<line x1="${padLeft}" y1="${gy}" x2="${padLeft + plotWidth}" y2="${gy}"
                stroke="currentColor" class="text-slate-800" stroke-width="1" />
              <text x="${padLeft - 8}" y="${gy + 4}" text-anchor="end"
                class="fill-slate-500" font-size="11">${Math.round(value)}</text>`;
    })
    .join('');

  // Faint marker wherever a new cycle began, so bursts line up with cycles.
  const boundaries = samples
    .map((sample, index) => {
      const previous = samples[index - 1];
      if (previous === undefined || sample.cycle === previous.cycle || sample.cycle === 0) {
        return '';
      }
      return `<line x1="${x(sample)}" y1="${padTop}" x2="${x(sample)}" y2="${baseline}"
                stroke="currentColor" class="text-slate-700" stroke-width="1"
                stroke-dasharray="2 4" />`;
    })
    .join('');

  const targetLine =
    target <= 0 || target > yMax
      ? ''
      : `<line x1="${padLeft}" y1="${y(target)}" x2="${padLeft + plotWidth}" y2="${y(target)}"
           stroke="currentColor" class="text-sky-400" stroke-width="1.5" stroke-dasharray="6 4" />
         <text x="${padLeft + plotWidth - 4}" y="${y(target) - 6}" text-anchor="end"
           class="fill-sky-400" font-size="11">target ${Math.round(target)}/min</text>`;

  const xTicks = [0, 0.25, 0.5, 0.75, 1]
    .map((fraction) => {
      const tickMs = firstMs + fraction * spanMs;
      const tx = padLeft + fraction * plotWidth;
      return `<text x="${tx}" y="${height - 10}" text-anchor="middle"
                class="fill-slate-500" font-size="11">${escapeHtml(formatDuration(tickMs))}</text>`;
    })
    .join('');

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}"
         role="img" aria-label="Achieved throughput over time"
         style="min-width:${width / 1.6}px">
      ${gridlines}
      ${boundaries}
      <path d="${area(failureTop, baseline)}" class="fill-rose-500/25" />
      <path d="${area(successTop, baseline)}" class="fill-emerald-500/20" />
      <path d="${totalLine}" fill="none" stroke="currentColor" class="text-sky-400"
            stroke-width="1.75" stroke-linejoin="round" />
      <path d="${retryLine}" fill="none" stroke="currentColor" class="text-amber-400"
            stroke-width="1.25" stroke-dasharray="2 3" />
      ${targetLine}
      <line x1="${padLeft}" y1="${baseline}" x2="${padLeft + plotWidth}" y2="${baseline}"
            stroke="currentColor" class="text-slate-700" stroke-width="1" />
      ${xTicks}
    </svg>
    <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
      <span class="flex items-center gap-1.5">
        <span class="inline-block h-2 w-4 rounded-sm bg-emerald-500/40"></span>successful
      </span>
      <span class="flex items-center gap-1.5">
        <span class="inline-block h-2 w-4 rounded-sm bg-rose-500/40"></span>failed
      </span>
      <span class="flex items-center gap-1.5">
        <span class="inline-block h-0.5 w-4 bg-sky-400"></span>total req/min
      </span>
      <span class="flex items-center gap-1.5">
        <span class="inline-block h-0.5 w-4 bg-amber-400"></span>retries/min (not throughput)
      </span>
    </div>`;
}

// --- metric time series -----------------------------------------------------

/**
 * Points drawn at once. A sliding window rather than the peak-preserving
 * `downsample` used for throughput: here every point is one cycle, and it is the
 * *consecutive* values and their differences that carry the meaning, so dropping
 * points out of the middle would misrepresent the series.
 */
const MAX_METRIC_POINTS_PLOTTED = 400;

/**
 * Cap on *hoverable* markers, independent of how many points the line covers.
 *
 * Every marker carries its own tooltip so that hovering needs no JavaScript, and
 * at 400 markers that markup is hundreds of kilobytes rebuilt on every poll.
 * Past roughly this many the dots are also less than a hit-radius apart, so the
 * tooltips overlap and are unusable anyway — thinning them costs nothing a user
 * could have read. The line itself is always drawn over every point.
 */
const MAX_METRIC_MARKERS = 96;

/**
 * Signature of the last chart drawn, so an unchanged series is not rebuilt.
 *
 * The poll runs every 400ms but a point only arrives once per cycle — minutes
 * apart at a normal interval — so almost every tick would otherwise re-emit
 * identical markup for no reason. The series is append-only (trimmed only at
 * its head), so its length plus its first and last cycle identify it exactly.
 */
let lastMetricChartKey = '';

/** Tooltip box, in viewBox units. */
const TIP = { width: 168, lineHeight: 15, padding: 9 } as const;

/**
 * Rounds an axis floor down to a multiple of `step`, never below zero.
 * Counterpart to `niceCeiling`, so both bounds land on the same grid.
 */
function floorTo(value: number, step: number): number {
  return Math.max(0, Math.floor(value / step) * step);
}

/**
 * Chooses the y-axis window.
 *
 * Zero-based by default, which is the honest reading of a count. But a view
 * counter sitting at 153,200 and moving by a few hundred an hour is a dead flat
 * line on a 0–200K axis, and watching those movements is the entire point of
 * this chart — so when the observed range is small relative to the magnitude,
 * the axis zooms to the data instead.
 *
 * Both bounds are quantized to a round step so that a new cycle nudges the line
 * rather than rescaling the whole chart underneath the operator.
 */
function metricAxis(values: readonly number[]): { min: number; max: number } {
  const hi = Math.max(...values);
  const lo = Math.min(...values);
  const span = hi - lo;

  if (span > 0 && span < hi * 0.25) {
    const step = niceCeiling(span / 2);
    return {
      min: floorTo(lo - span * 0.25, step),
      max: Math.ceil((hi + span * 0.25) / step) * step,
    };
  }

  return { min: 0, max: niceCeiling(Math.max(1, hi) * 1.05) };
}

/**
 * One tooltip: cycle, timestamp, the exact integer, and the change from the
 * previous cycle that had a value.
 *
 * The exact figure is deliberately the prominent line. Axis labels abbreviate
 * (`153.2K`), and this is where the operator confirms what the scraper actually
 * returned — including a platform's own quantized figure, which must pass
 * through unaltered.
 */
function metricTooltip(point: MetricPlotPoint, metric: string, x: number, y: number): string {
  const hasDelta = point.delta !== null;
  const lines = hasDelta ? 5 : 4;
  const height = TIP.padding * 2 + TIP.lineHeight * lines;

  // Flip to the left near the right-hand edge so the box cannot run off the
  // viewBox and get clipped.
  const flip = x > CHART.padLeft + (CHART.width - CHART.padLeft - CHART.padRight) * 0.62;
  const boxX = flip ? x - TIP.width - 10 : x + 10;
  const boxY = Math.min(
    CHART.height - CHART.padBottom - height,
    Math.max(CHART.padTop, y - height / 2),
  );

  const textX = boxX + TIP.padding;
  const line = (index: number): number => boxY + TIP.padding + TIP.lineHeight * (index + 0.8);

  const value =
    point.value === null
      ? `<text x="${textX}" y="${line(3)}" class="fill-slate-400" font-size="12">no value (${escapeHtml(point.status)})</text>`
      : `<text x="${textX}" y="${line(3)}" class="fill-slate-100" font-size="14" font-family="ui-monospace, monospace">${escapeHtml(formatExact(point.value))}</text>`;

  const delta =
    point.delta === null
      ? ''
      : `<text x="${textX}" y="${line(4)}" font-size="11" font-family="ui-monospace, monospace" class="${point.delta >= 0 ? 'fill-emerald-400' : 'fill-rose-400'}">${escapeHtml(formatDelta(point.delta))}</text>`;

  // Whitespace kept out of the template on purpose: this markup is emitted once
  // per marker and rebuilt on every poll, so its size is a running cost.
  return (
    `<g class="metric-tip">` +
    `<rect x="${boxX}" y="${boxY}" width="${TIP.width}" height="${height}" rx="6" class="fill-slate-950 stroke-slate-700" stroke-width="1" opacity="0.97" />` +
    `<text x="${textX}" y="${line(0)}" class="fill-slate-200" font-size="12" font-weight="600">Cycle ${String(point.cycle)}</text>` +
    `<text x="${textX}" y="${line(1)}" class="fill-slate-500" font-size="10">${escapeHtml(formatTimestamp(point.at))}</text>` +
    `<text x="${textX}" y="${line(2)}" class="fill-slate-500" font-size="10">${escapeHtml(metric)}</text>` +
    value +
    delta +
    `</g>`
  );
}

/**
 * A single video's metrics across the cycles of a continuous session.
 *
 * Continuous mode with exactly one URL only: with a batch there is no single
 * series to plot, and a one-shot run has nothing to plot it against. Drawn with
 * the same hand-rolled SVG approach — and the same `CHART` box, `niceCeiling`
 * and `pathFrom` helpers — as the throughput graph above it, so the dashboard
 * still carries no charting dependency.
 */
function renderMetricSeriesChart(state: AppState): void {
  const panel = el('metric-series-panel');
  const container = el('metric-series-chart');

  // `input.accepted` is the server's own parsed URL count, so this agrees with
  // what actually ran rather than with what the textarea happens to contain.
  const singleUrl = state.input !== null && state.input.accepted === 1;
  if (!state.continuous || !singleUrl) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');

  for (const button of document.querySelectorAll<HTMLButtonElement>('.metric-tab-btn')) {
    button.dataset['active'] = String(button.dataset['metric'] === state.metric);
  }

  const first = state.metricSeries[0];
  const last = state.metricSeries[state.metricSeries.length - 1];
  const key = `${state.metric}|${String(state.metricSeries.length)}|${String(first?.cycle)}|${String(last?.cycle)}`;
  // The container's own content is part of the condition: the cache is only
  // valid while what it describes is still on the page.
  if (key === lastMetricChartKey && container.innerHTML !== '') return;
  lastMetricChartKey = key;

  const label = METRIC_LABELS[state.metric];
  // Deltas are computed over the whole series *before* windowing, so trimming
  // for display can never change a number the operator reads.
  const all = toPlotPoints(state.metricSeries, state.metric);
  const points = all.slice(-MAX_METRIC_POINTS_PLOTTED);
  const values = points
    .filter((point) => point.value !== null)
    .map((point) => point.value as number);

  if (values.length === 0) {
    container.innerHTML = `<p class="py-12 text-center text-sm text-slate-500">
      ${points.length === 0 ? 'Waiting for the first cycle…' : `No ${escapeHtml(label.toLowerCase())} reported yet.`}
    </p>`;
    return;
  }

  const { width, height, padLeft, padRight, padTop, padBottom } = CHART;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;

  const axis = metricAxis(values);
  const ySpan = Math.max(1, axis.max - axis.min);
  const firstMs = points[0]?.tMs ?? 0;
  const lastMs = points[points.length - 1]?.tMs ?? firstMs;
  const spanMs = lastMs - firstMs;

  // A lone point sits in the middle rather than pinned to the left edge, where
  // it would read as the start of a line that is not there.
  const x = (point: MetricPlotPoint): number =>
    spanMs <= 0 ? padLeft + plotWidth / 2 : padLeft + ((point.tMs - firstMs) / spanMs) * plotWidth;
  const y = (value: number): number =>
    padTop + plotHeight - ((value - axis.min) / ySpan) * plotHeight;

  // Split into runs of consecutive points that have values: a cycle that
  // reported nothing leaves a visible break instead of an interpolated line
  // across data that was never collected.
  const segments: string[] = [];
  let run: (readonly [number, number])[] = [];
  for (const point of points) {
    if (point.value === null) {
      if (run.length > 1) segments.push(pathFrom(run));
      run = [];
      continue;
    }
    run.push([x(point), y(point.value)] as const);
  }
  if (run.length > 1) segments.push(pathFrom(run));

  const gridlines = [0, 0.25, 0.5, 0.75, 1]
    .map((fraction) => {
      const value = axis.min + fraction * ySpan;
      const gy = y(value);
      return `<line x1="${padLeft}" y1="${gy}" x2="${padLeft + plotWidth}" y2="${gy}"
                stroke="currentColor" class="text-slate-800" stroke-width="1" />
              <text x="${padLeft - 8}" y="${gy + 4}" text-anchor="end"
                class="fill-slate-500" font-size="11">${escapeHtml(formatCompact(value))}</text>`;
    })
    .join('');

  const xTicks =
    spanMs <= 0
      ? ''
      : [0, 0.25, 0.5, 0.75, 1]
          .map((fraction) => {
            const tx = padLeft + fraction * plotWidth;
            const anchor = fraction === 0 ? 'start' : fraction === 1 ? 'end' : 'middle';
            return `<text x="${tx}" y="${height - 10}" text-anchor="${anchor}"
                      class="fill-slate-500" font-size="11"
                    >${escapeHtml(formatClock(firstMs + fraction * spanMs))}</text>`;
          })
          .join('');

  // Every cycle that reported nothing gets a rule, whatever the marker density:
  // an outage must never be thinned away, and the rule is cheap.
  const gaps = points
    .filter((point) => point.value === null)
    .map(
      (point) => `<line x1="${x(point)}" y1="${padTop}" x2="${x(point)}" y2="${padTop + plotHeight}"
            stroke="currentColor" class="text-rose-500/40" stroke-width="1" stroke-dasharray="2 4" />`,
    )
    .join('');

  // Thinned to a density a cursor can actually separate. The newest point is
  // always kept — it is the one being watched.
  const stride = Math.ceil(points.length / MAX_METRIC_MARKERS);
  const markers = points
    .filter((_, index) => index % stride === 0 || index === points.length - 1)
    .map((point) => {
      const px = x(point);
      // A failed cycle is pinned to the baseline, hollow, so it reads as an
      // absence rather than as a value of zero.
      const py = point.value === null ? padTop + plotHeight : y(point.value);
      const dot =
        point.value === null
          ? `<circle cx="${px}" cy="${py}" r="3" fill="none" stroke="currentColor" class="text-rose-400" stroke-width="1.5" />`
          : `<circle cx="${px}" cy="${py}" r="3" class="fill-sky-400" />`;
      return `<g class="metric-point">${dot}<circle cx="${px}" cy="${py}" r="12" fill="transparent" />${metricTooltip(point, label, px, py)}</g>`;
    })
    .join('');

  const line = segments
    .map(
      (path) => `<path d="${path}" fill="none" stroke="currentColor" class="text-sky-400"
                       stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round" />`,
    )
    .join('');

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}"
         role="img" aria-label="${escapeHtml(label)} per cycle"
         style="min-width:${width / 1.6}px">
      ${gridlines}
      ${gaps}
      ${line}
      ${markers}
      <line x1="${padLeft}" y1="${padTop + plotHeight}" x2="${padLeft + plotWidth}"
            y2="${padTop + plotHeight}" stroke="currentColor" class="text-slate-700"
            stroke-width="1" />
      ${xTicks}
    </svg>
    <p class="mt-2 text-[11px] text-slate-500">
      ${String(all.length)} cycle${all.length === 1 ? '' : 's'} ·
      hover a point for the exact ${escapeHtml(label.toLowerCase())} count and its change
    </p>`;
}
