import { formatProvenance, type Maybe, type Provenance } from '../../core/capacity/index.js';

import { renderCapacityCharts } from './charts.js';
import type { CapacityState } from './state.js';

function el(id: string): HTMLElement | null {
  return document.getElementById(id);
}

export function renderCapacity(state: CapacityState): void {
  renderForm(state);
  renderStages(state);
  renderValidation(state);
  renderResults(state);
  renderFindings(state);
  renderProvenance(state);
  renderCharts(state);
}

function renderForm(state: CapacityState): void {
  setValue('platform-preset', state.platformPreset);
  setValue('lifecycle-preset', state.lifecyclePreset);
  setValue('new-submissions', state.inputs.newSubmissionsPerDay);
  setValue('horizon-days', state.inputs.horizonDays);
  setValue('requests-per-job', state.inputs.requestsPerJob);
  setValue('bytes-per-request', state.inputs.bytesPerHttpRequest);
  setValue('mean-job-latency', state.inputs.meanJobLatencyMs);
  setValue('p95-job-latency', state.inputs.p95JobLatencyMs);
  setValue('mean-http-latency', state.inputs.meanHttpLatencyMs);
  setValue('p95-http-latency', state.inputs.p95HttpLatencyMs);
  setValue('attempt-success-rate', state.inputs.reliability.perAttemptSuccessRate);
  setValue('permanent-failure-share', state.inputs.reliability.nonRetryableShare);
  setValue('max-attempts', state.inputs.reliability.maxAttempts);
  setValue('retry-initial-delay', state.inputs.reliability.retryBackoff.initialDelayMs);
  setValue('retry-max-delay', state.inputs.reliability.retryBackoff.maxDelayMs);
  setValue('retry-factor', state.inputs.reliability.retryBackoff.backoffFactor);
  setChecked('retry-jitter', state.inputs.reliability.retryBackoff.jitter);
  setValue('job-target-rpm', state.inputs.capacity.targetJobsPerMinute);
  setValue('peak-multiplier', state.inputs.capacity.peakMultiplier);
  setValue('peak-override', state.inputs.capacity.peakJobsPerMinuteOverride);
  setValue('workers', state.inputs.capacity.workers);
  setValue('worker-concurrency', state.inputs.capacity.concurrencyPerWorker);
  setValue('http-rpm-limit', state.inputs.capacity.httpRpmPerHost);
  setValue('proxy-pool-size', state.inputs.capacity.proxyPoolSize);
  setValue('proxy-concurrency-limit', state.inputs.capacity.proxyLimits.maxConcurrentPerProxy);
  setValue('proxy-rpm-limit', state.inputs.capacity.proxyLimits.maxRequestsPerMinutePerProxy);
  setValue('proxy-bandwidth-limit', state.inputs.capacity.proxyLimits.maxBytesPerMonthPerProxy);
  setValue('proxy-probation', state.inputs.capacity.proxyLimits.probationConcurrency);
  setValue('proxy-earned', state.inputs.capacity.proxyLimits.earnedConcurrencyPerProxy);
  setValue('safety-margin', state.inputs.capacity.safetyMargin);
  setValue('price-per-gb', state.inputs.pricing.pricePerGb);
  setValue('billing-unit', state.inputs.pricing.billingUnit);
  setChecked('bill-failed-attempts', state.inputs.pricing.billsFailedAttempts);
  setValue('price-per-proxy', state.inputs.pricing.fixedMonthlyPerProxy);
  setValue('fixed-pool-price', state.inputs.pricing.fixedMonthlyPool);
  setChecked('growth-enabled', state.inputs.growth.enabled);
  setValue('growth-rate', state.inputs.growth.monthlyGrowthRate);
  setValue('growth-months', state.inputs.growth.months);
}

function renderStages(state: CapacityState): void {
  const target = el('lifecycle-stages');
  if (target === null) return;
  target.innerHTML = state.inputs.stages
    .map(
      (stage, index) => `<article class="stage-row" data-stage-index="${String(index)}">
        <div class="stage-heading">
          <label><input type="checkbox" data-stage-field="enabled" ${stage.enabled ? 'checked' : ''} /> enabled</label>
          <div class="stage-actions">
            <button type="button" data-stage-action="up" aria-label="Move ${escapeHtml(stage.label)} up">↑</button>
            <button type="button" data-stage-action="down" aria-label="Move ${escapeHtml(stage.label)} down">↓</button>
            <button type="button" data-stage-action="remove" aria-label="Remove ${escapeHtml(stage.label)}">Remove</button>
          </div>
        </div>
        <div class="stage-fields">
          <label>Label<input data-stage-field="label" value="${escapeHtml(stage.label)}" /></label>
          <label>Days<input type="number" min="1" step="1" data-stage-field="durationDays" value="${String(stage.durationDays)}" /></label>
          <label>Interval (minutes)<input type="number" min="0" step="any" data-stage-field="intervalMinutes" value="${stage.intervalMs === null ? '' : String(stage.intervalMs / 60_000)}" placeholder="no polling" /></label>
        </div>
      </article>`,
    )
    .join('');
}

function renderValidation(state: CapacityState): void {
  const target = el('validation-results');
  if (target === null) return;
  target.classList.toggle('hidden', state.result.validation.valid);
  target.innerHTML = state.result.validation.valid
    ? ''
    : `<h2>Check these inputs</h2><ul>${state.result.validation.issues
        .map(
          (issue) =>
            `<li><code>${escapeHtml(issue.path)}</code> — ${escapeHtml(issue.message)}</li>`,
        )
        .join('')}</ul>`;
}

function renderResults(state: CapacityState): void {
  const { result } = state;
  setHtml(
    'overview-results',
    cards([
      ['Active submissions', formatNumber(result.workload.activeSubmissionsAtRunRate)],
      ['Polled submissions', formatNumber(result.workload.polledSubmissionsAtRunRate)],
      ['Logical jobs/day', formatNumber(result.traffic.logicalJobsPerDay)],
      ['Logical jobs/month', formatNumber(result.traffic.logicalJobsPerMonth)],
      ['Horizon jobs', formatNumber(result.traffic.logicalJobsInHorizon)],
      ['Polling plateau', dayValue(result.workload.pollingPlateauDay)],
      ['Active plateau', dayValue(result.workload.activeLifecyclePlateauDay)],
    ]),
  );
  setHtml(
    'reliability-results',
    cards([
      ['Job success', formatPercent(result.reliability.jobSuccessRate)],
      ['Permanent failures', formatPercent(result.reliability.permanentFailureRate)],
      ['Retry rate', formatPercent(result.reliability.retryRate)],
      ['Attempt amplification', `${result.reliability.attemptAmplification.toFixed(4)}×`],
      ['Retries/day', formatNumber(result.traffic.retriesPerDay)],
      ['Expected backoff/job', `${result.reliability.expectedBackoffMsPerJob.toFixed(1)} ms`],
    ]),
  );
  setHtml(
    'traffic-results',
    cards([
      ['Logical jobs/day', formatNumber(result.traffic.logicalJobsPerDay)],
      ['Baseline HTTP/day', formatMaybe(result.traffic.baselineHttpRequestsPerDay)],
      ['Adjusted HTTP/day', formatMaybe(result.traffic.adjustedHttpRequestsPerDay)],
      ['Baseline HTTP/month', formatMaybe(result.traffic.baselineHttpRequestsPerMonth)],
      ['Adjusted HTTP/month', formatMaybe(result.traffic.adjustedHttpRequestsPerMonth)],
      ['Adjusted HTTP in horizon', formatMaybe(result.traffic.adjustedHttpRequestsInHorizon)],
    ]),
  );
  setHtml(
    'bandwidth-results',
    cards([
      ['Baseline/day', formatMaybe(result.bandwidth.baselineGbPerDay, ' GB')],
      ['Baseline/month', formatMaybe(result.bandwidth.baselineGbPerMonth, ' GB')],
      ['Adjusted/day', formatMaybe(result.bandwidth.adjustedGbPerDay, ' GB')],
      ['Adjusted/month', formatMaybe(result.bandwidth.adjustedGbPerMonth, ' GB')],
      ['Baseline horizon', formatMaybeBytes(result.bandwidth.baselineBytesInHorizon)],
      ['Adjusted horizon', formatMaybeBytes(result.bandwidth.adjustedBytesInHorizon)],
    ]),
  );
  setHtml(
    'concurrency-results',
    cards([
      ['Average jobs', formatMaybe(result.concurrency.averageJobs)],
      ['Peak jobs', formatMaybe(result.concurrency.peakJobs)],
      ['Average HTTP', formatMaybe(result.concurrency.averageHttpRequests)],
      ['Peak HTTP', formatMaybe(result.concurrency.peakHttpRequests)],
      ['Peak jobs/min', formatNumber(result.peak.jobsPerMinute)],
      ['Peak source', result.peak.source],
    ]),
  );
  setHtml(
    'worker-results',
    cards([
      ['Configured slots', formatNumber(result.workers.aggregateJobConcurrency)],
      ['Job target/min', formatNumber(result.workers.aggregateJobTargetPerMinute)],
      ['HTTP limit/min', formatMaybe(result.workers.aggregateHttpLimitPerMinute)],
      ['Workers by concurrency', formatMaybe(result.workers.requiredByConcurrency, '', 0)],
      ['Workers by target', formatMaybe(result.workers.requiredByJobTarget, '', 0)],
      ['Recommended workers', formatMaybe(result.workers.recommendedWorkers, '', 0)],
    ]),
  );
  setHtml(
    'proxy-results',
    cards([
      ['Binding constraint', result.proxy.bindingConstraint ?? 'unavailable'],
      ['Raw requirement', formatMaybe(result.proxy.rawRequired)],
      ['Theoretical proxies', formatMaybe(result.proxy.theoreticalProxies, '', 0)],
      ['Recommended proxies', formatMaybe(result.proxy.recommendedProxies, '', 0)],
      ['Configured utilization', formatMaybePercent(result.proxy.configuredPoolUtilization)],
      ['Configured headroom', formatMaybe(result.proxy.configuredPoolHeadroom, '', 0)],
      ['Requests/proxy/day', formatMaybe(result.proxy.requestsPerProxyPerDay)],
      ['Concurrency/proxy', formatMaybe(result.proxy.concurrencyPerProxy)],
    ]),
  );
  setHtml(
    'cost-results',
    cards([
      [
        `Billable ${state.inputs.pricing.billingUnit}/month`,
        formatMaybe(result.cost.billingBandwidthUnitsPerMonth),
      ],
      ['Bandwidth/month', formatMoneyMaybe(result.cost.bandwidthMonthly)],
      ['Static proxies/month', formatMoneyMaybe(result.cost.proxiesMonthly)],
      ['Fixed pool/month', formatMoneyMaybe(result.cost.fixedPoolMonthly)],
      ['Total/month', formatMoneyMaybe(result.cost.totalMonthly)],
    ]),
  );
  setHtml(
    'growth-results',
    `<div class="table-wrap"><table><thead><tr><th>Month</th><th>Factor</th><th>Submissions/day</th><th>Jobs/day</th><th>GB/month</th><th>Proxies</th><th>Cost</th></tr></thead><tbody>${result.growth
      .map(
        (month) =>
          `<tr><td>${String(month.month)}</td><td>${month.factor.toFixed(3)}×</td><td>${formatNumber(month.newSubmissionsPerDay)}</td><td>${formatNumber(month.logicalJobsPerDay)}</td><td>${formatMaybe(month.adjustedGbPerMonth)}</td><td>${formatMaybe(month.recommendedProxies, '', 0)}</td><td>${formatMoneyMaybe(month.estimatedMonthlyCost)}</td></tr>`,
      )
      .join('')}</tbody></table></div>`,
  );
  setHtml(
    'timeline-results',
    `<div class="table-wrap"><table><thead><tr><th>Day</th><th>Phase</th><th>Active</th><th>Polled</th><th>Jobs</th><th>Adjusted HTTP</th></tr></thead><tbody>${result.timeline
      .map(
        (point) =>
          `<tr><td>${String(point.day)}</td><td>${point.phase}</td><td>${formatNumber(point.activeSubmissions)}</td><td>${formatNumber(point.polledSubmissions)}</td><td>${formatNumber(point.scrapeJobs)}</td><td>${formatMaybe(point.adjustedHttpRequests)}</td></tr>`,
      )
      .join('')}</tbody></table></div>`,
  );
}

function renderFindings(state: CapacityState): void {
  setHtml(
    'findings-results',
    state.result.findings.length === 0
      ? '<p class="empty-state">No model findings.</p>'
      : state.result.findings
          .map(
            (finding) =>
              `<article class="finding ${finding.severity}"><span>${finding.severity}</span><div><strong>${escapeHtml(finding.code.replaceAll('_', ' '))}</strong><p>${escapeHtml(finding.detail)}</p></div></article>`,
          )
          .join(''),
  );
}

function renderProvenance(state: CapacityState): void {
  setHtml(
    'provenance-results',
    Object.entries(state.result.provenance)
      .map(
        ([path, provenance]) =>
          `<div class="provenance-row"><code>${escapeHtml(path)}</code>${provenanceBadge(provenance)}</div>`,
      )
      .join(''),
  );
}

function renderCharts(state: CapacityState): void {
  const charts = renderCapacityCharts(state.result);
  setHtml('workload-chart', charts.workload);
  setHtml('traffic-chart', charts.traffic);
  setHtml('bandwidth-chart', charts.bandwidth);
  setHtml('concurrency-chart', charts.concurrency);
  setHtml('proxy-chart', charts.proxy);
  setHtml('growth-chart', charts.growth);
}

function cards(items: readonly (readonly [string, string])[]): string {
  return items
    .map(
      ([label, value]) =>
        `<div class="result-card"><span>${escapeHtml(label)}</span><strong>${value}</strong></div>`,
    )
    .join('');
}

function formatMaybe(value: Maybe<number>, suffix = '', digits = 2): string {
  return value.computable
    ? `${formatNumber(value.value, digits)}${suffix}`
    : unavailable(value.reason);
}

function formatMaybeBytes(value: Maybe<number>): string {
  return value.computable
    ? `${formatNumber(value.value / 1_000_000_000)} GB`
    : unavailable(value.reason);
}

function formatMaybePercent(value: Maybe<number>): string {
  return value.computable ? formatPercent(value.value) : unavailable(value.reason);
}

function formatMoneyMaybe(value: Maybe<number>): string {
  return value.computable
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value.value)
    : unavailable(value.reason);
}

function unavailable(reason: string): string {
  return `<span class="unavailable" title="${escapeHtml(reason)}">Unavailable</span>`;
}

function formatNumber(value: number, digits = 2): string {
  const safe = Number.isFinite(value) ? value : 0;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(safe);
}

function formatPercent(value: number): string {
  return `${formatNumber(value * 100, 2)}%`;
}

function dayValue(day: number | null): string {
  return day === null
    ? unavailable('the simulation horizon has not reached this plateau')
    : `Day ${String(day)}`;
}

function provenanceBadge(provenance: Provenance): string {
  return `<span class="provenance-badge ${provenance.kind}" title="${escapeHtml(formatProvenance(provenance))}">${escapeHtml(provenance.kind)}</span>`;
}

function setHtml(id: string, html: string): void {
  const target = el(id);
  if (target !== null) target.innerHTML = html;
}

function setValue(id: string, value: string | number | null): void {
  const target = el(id);
  if (target !== null && 'value' in target) target.value = value === null ? '' : String(value);
}

function setChecked(id: string, checked: boolean): void {
  const target = el(id);
  if (target !== null && 'checked' in target) target.checked = checked;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
