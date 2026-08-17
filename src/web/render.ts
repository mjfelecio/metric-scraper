import { type RecentResultDto, type RunState } from '../app/types.js';
import { type ScrapeStatus } from '../core/models/status.js';

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
  completed: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  failed: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
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
  renderResults(state);
  renderInputReport(state);
  renderSummary(state);
  renderDefaults(state);
}

function renderControls(state: AppState): void {
  const active = isRunActive(state.status);

  for (const id of ['platform', 'input-text', 'input-file', 'concurrency', 'target-rpm']) {
    const node = document.getElementById(id);
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
      node.disabled = active;
    } else if (node instanceof HTMLSelectElement) {
      node.disabled = active;
    }
  }

  const start = el<HTMLButtonElement>('start-button');
  start.disabled = active;
  start.textContent = active ? 'Running…' : 'Start run';

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

  stats.innerHTML = statCards([
    ['Processed', `${progress.processed} / ${progress.total}`],
    ['Successful', String(progress.successful)],
    ['Failed', String(progress.failed)],
    ['Throughput', `${progress.throughputPerMinute.toFixed(0)}/min`],
    ['Elapsed', `${(progress.elapsedMs / 1000).toFixed(1)}s`],
    ['In flight', String(progress.inFlight)],
    ['Queued', String(progress.queued)],
    ['Errors', String(progress.failed)],
  ]);
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

  panel.innerHTML = `
    <h2 class="mb-4 text-sm font-semibold uppercase tracking-wider text-slate-400">Run summary</h2>
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      ${statCards([
        ['Success rate', `${(summary.totals.success_rate * 100).toFixed(1)}%`],
        ['Throughput', `${summary.throughput.requests_per_minute.toFixed(1)}/min`],
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
