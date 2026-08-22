import {
  formatProvenance,
  type Maybe,
  type Provenance,
  type SystemCapacityConstraintKind,
} from '../../core/capacity/index.js';

import { renderCapacityCharts } from './charts.js';
import {
  FINDING_DOCUMENTATION,
  INPUT_DOCUMENTATION,
  METRIC_DOCUMENTATION,
  PROVENANCE_INPUT_LABELS,
} from './documentation.js';
import type { CapacityState } from './state.js';

function el(id: string): HTMLElement | null {
  return document.getElementById(id);
}

export function renderCapacity(state: CapacityState): void {
  renderForm(state);
  renderInputDocumentation(state);
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

/** Adds one reusable, focusable help affordance beside each non-obvious input label. */
function renderInputDocumentation(state: CapacityState): void {
  // The render unit tests use a deliberately tiny DOM stand-in. Input help is
  // progressive enhancement around real form controls, so the stand-in can
  // skip this branch while still exercising every calculated result.
  if (typeof document.createElement !== 'function') return;

  for (const documentation of INPUT_DOCUMENTATION) {
    const control = document.getElementById(documentation.id);
    const label = control?.closest<HTMLLabelElement>('label');
    if (control === null || control === undefined || label === null || label === undefined)
      continue;

    let tip = label.querySelector<HTMLElement>(`[data-input-help-for="${documentation.id}"]`);
    if (tip === null) {
      tip = document.createElement('span');
      tip.className = 'info-tip input-info-tip';
      tip.tabIndex = 0;
      tip.setAttribute('role', 'button');
      tip.dataset['inputHelpFor'] = documentation.id;
      tip.setAttribute('aria-label', `About ${labelText(label)}`);
      if (control instanceof HTMLInputElement && control.type === 'checkbox') {
        label.append(tip);
      } else {
        label.insertBefore(tip, control);
      }
    }

    const provenance =
      documentation.path === undefined ? undefined : state.result.provenance[documentation.path];
    tip.innerHTML = `i<span id="help-${documentation.id}" class="info-popover" role="tooltip">
      <span>${escapeHtml(documentation.explanation)}</span>
      ${provenance === undefined ? '' : `<span class="input-provenance">Source confidence: ${provenanceBadge(provenance)}</span>`}
    </span>`;
    control.setAttribute('aria-describedby', `help-${documentation.id}`);
  }
}

function labelText(label: HTMLLabelElement): string {
  return (label.childNodes[0]?.textContent ?? 'this input').trim();
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
          <label>Label${infoTip('Operator-facing name for this age-based lifecycle stage.', 'stage label')}<input data-stage-field="label" value="${escapeHtml(stage.label)}" /></label>
          <label>Days${infoTip('Whole days a submission remains in this enabled stage before moving to the next enabled stage.', 'stage days')}<input type="number" min="1" step="1" data-stage-field="durationDays" value="${String(stage.durationDays)}" /></label>
          <label>Interval (minutes)${infoTip('Start-to-start time between scheduled scrapes. Blank retains submissions in a dormant stage without creating jobs.', 'polling interval')}<input type="number" min="0" step="any" data-stage-field="intervalMinutes" value="${stage.intervalMs === null ? '' : String(stage.intervalMs / 60_000)}" placeholder="no polling" /></label>
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
  const capacityWorkload = result.capacityWorkload;
  const isOverCapacity = capacityWorkload.status === 'over-capacity';
  setHtml(
    'planning-summary-results',
    cards([
      metric(
        'currentSubmissionsDay',
        'Current workload',
        `${formatNumber(capacityWorkload.currentSubmissionsPerDay)} submissions/day`,
        true,
      ),
      metric(
        'steadyStateJobsDay',
        'Steady-state workload',
        `${formatNumber(capacityWorkload.currentJobsPerDay)} jobs/day`,
        true,
      ),
      metric(
        'sustainableJobsDay',
        'Sustainable system capacity',
        formatMaybe(capacityWorkload.sustainableJobsPerDay, ' jobs/day'),
        true,
      ),
      metric(
        'capacityUtilization',
        'Capacity utilization',
        formatMaybePercent(capacityWorkload.utilization),
        true,
      ),
      metric(
        isOverCapacity ? 'overCapacityJobsDay' : 'capacityHeadroom',
        isOverCapacity ? 'Over capacity' : 'Headroom',
        formatMaybe(
          isOverCapacity
            ? capacityWorkload.overCapacityJobsPerDay
            : capacityWorkload.headroomJobsPerDay,
          ' jobs/day',
        ),
        true,
      ),
      metric(
        'maximumSubmissionsDay',
        'Maximum sustainable submissions/day',
        formatMaybe(capacityWorkload.maximumSustainableSubmissionsPerDay, '/day', 0),
        true,
      ),
      metric(
        'systemBindingConstraint',
        'Binding constraint',
        capacityWorkload.bindingConstraint === null
          ? unavailable('sustainable infrastructure capacity is unavailable')
          : systemConstraintLabel(capacityWorkload.bindingConstraint),
      ),
      metric(
        'lifetimeScrapesPerSubmission',
        'Lifetime scrapes/submission',
        formatNumber(capacityWorkload.lifetimeScrapeJobsPerSubmission, 0),
      ),
    ]),
  );
  setHtml('capacity-workload-status', capacityWorkloadStatus(state));
  setHtml(
    'overview-results',
    cards([
      metric(
        'activeSubmissions',
        'Active submissions',
        formatNumber(result.workload.activeSubmissionsAtRunRate),
      ),
      metric(
        'polledSubmissions',
        'Polled submissions',
        formatNumber(result.workload.polledSubmissionsAtRunRate),
      ),
      metric(
        'logicalJobsDay',
        'Logical jobs/day',
        formatNumber(result.traffic.logicalJobsPerDay),
        true,
      ),
      metric(
        'logicalJobsMonth',
        'Logical jobs/month',
        formatNumber(result.traffic.logicalJobsPerMonth),
      ),
      metric('horizonJobs', 'Horizon jobs', formatNumber(result.traffic.logicalJobsInHorizon)),
      metric('pollingPlateau', 'Polling plateau', dayValue(result.workload.pollingPlateauDay)),
      metric(
        'activePlateau',
        'Active plateau',
        dayValue(result.workload.activeLifecyclePlateauDay),
      ),
    ]),
  );
  setHtml(
    'reliability-results',
    cards([
      metric(
        'jobSuccess',
        'Eventual job success',
        formatPercent(result.reliability.jobSuccessRate),
      ),
      metric(
        'permanentFailures',
        'Permanent failures',
        formatPercent(result.reliability.permanentFailureRate),
      ),
      metric('retryRate', 'Jobs that retry', formatPercent(result.reliability.retryRate)),
      metric(
        'attemptAmplification',
        'Attempt amplification',
        `${result.reliability.attemptAmplification.toFixed(4)}×`,
      ),
      metric('retriesDay', 'Retries/day', formatNumber(result.traffic.retriesPerDay)),
      metric(
        'expectedBackoff',
        'Expected backoff/job',
        `${result.reliability.expectedBackoffMsPerJob.toFixed(1)} ms`,
      ),
    ]),
  );
  setHtml(
    'traffic-results',
    cards([
      metric('logicalJobsDay', 'Logical jobs/day', formatNumber(result.traffic.logicalJobsPerDay)),
      metric(
        'baselineHttpDay',
        'HTTP/day · before retries',
        formatMaybe(result.traffic.baselineHttpRequestsPerDay),
      ),
      metric(
        'adjustedHttpDay',
        'HTTP/day · with retries',
        formatMaybe(result.traffic.adjustedHttpRequestsPerDay),
        true,
      ),
      metric(
        'baselineHttpMonth',
        'HTTP/month · before retries',
        formatMaybe(result.traffic.baselineHttpRequestsPerMonth),
      ),
      metric(
        'adjustedHttpMonth',
        'HTTP/month · with retries',
        formatMaybe(result.traffic.adjustedHttpRequestsPerMonth),
      ),
      metric(
        'adjustedHttpHorizon',
        'HTTP in horizon · with retries',
        formatMaybe(result.traffic.adjustedHttpRequestsInHorizon),
      ),
    ]),
  );
  setHtml(
    'bandwidth-results',
    cards([
      metric(
        'baselineBandwidthDay',
        'Daily · before retries',
        formatMaybe(result.bandwidth.baselineGbPerDay, ' GB'),
      ),
      metric(
        'baselineBandwidthMonth',
        'Monthly · before retries',
        formatMaybe(result.bandwidth.baselineGbPerMonth, ' GB'),
      ),
      metric(
        'adjustedBandwidthDay',
        'Daily · with retries',
        formatMaybe(result.bandwidth.adjustedGbPerDay, ' GB'),
      ),
      metric(
        'adjustedBandwidthMonth',
        'Monthly · with retries',
        formatMaybe(result.bandwidth.adjustedGbPerMonth, ' GB'),
        true,
      ),
      metric(
        'baselineBandwidthHorizon',
        'Horizon · before retries',
        formatMaybeBytes(result.bandwidth.baselineBytesInHorizon),
      ),
      metric(
        'adjustedBandwidthHorizon',
        'Horizon · with retries',
        formatMaybeBytes(result.bandwidth.adjustedBytesInHorizon),
      ),
    ]),
  );
  setHtml(
    'concurrency-results',
    cards([
      metric(
        'averageJobsConcurrency',
        'Average jobs in flight',
        formatMaybe(result.concurrency.averageJobs),
      ),
      metric(
        'peakJobsConcurrency',
        'Peak jobs in flight',
        formatMaybe(result.concurrency.peakJobs),
      ),
      metric(
        'averageHttpConcurrency',
        'Average HTTP in flight',
        formatMaybe(result.concurrency.averageHttpRequests),
      ),
      metric(
        'peakHttpConcurrency',
        'Peak HTTP in flight',
        formatMaybe(result.concurrency.peakHttpRequests),
      ),
      metric('peakJobsMinute', 'Peak jobs/min', formatNumber(result.peak.jobsPerMinute)),
      metric('peakSource', 'Peak source', result.peak.source),
    ]),
  );
  setHtml(
    'worker-results',
    cards([
      metric(
        'configuredSlots',
        'Configured job slots',
        formatNumber(result.workers.aggregateJobConcurrency),
      ),
      metric(
        'jobTargetMinute',
        'Aggregate job target/min',
        formatNumber(result.workers.aggregateJobTargetPerMinute),
      ),
      metric(
        'httpLimitMinute',
        'Aggregate HTTP limit/min',
        formatMaybe(result.workers.aggregateHttpLimitPerMinute),
      ),
      metric(
        'workersByConcurrency',
        'Workers needed · concurrency',
        formatMaybe(result.workers.requiredByConcurrency, '', 0),
      ),
      metric(
        'workersByTarget',
        'Workers needed · job target',
        formatMaybe(result.workers.requiredByJobTarget, '', 0),
      ),
      metric(
        'recommendedWorkers',
        'Recommended workers',
        formatMaybe(result.workers.recommendedWorkers, '', 0),
        true,
      ),
    ]),
  );
  setHtml(
    'proxy-results',
    cards([
      metric(
        'bindingConstraint',
        'Binding constraint',
        result.proxy.bindingConstraint ?? unavailable('no applicable per-proxy limit is available'),
      ),
      metric('rawProxyRequirement', 'Raw proxy requirement', formatMaybe(result.proxy.rawRequired)),
      metric(
        'theoreticalProxies',
        'Theoretical proxies',
        formatMaybe(result.proxy.theoreticalProxies, '', 0),
      ),
      metric(
        'recommendedProxies',
        'Recommended proxies',
        formatMaybe(result.proxy.recommendedProxies, '', 0),
        true,
      ),
      metric(
        'configuredProxyUtilization',
        'Configured pool utilization',
        formatMaybePercent(result.proxy.configuredPoolUtilization),
      ),
      metric(
        'configuredProxyHeadroom',
        'Configured pool headroom',
        formatMaybe(result.proxy.configuredPoolHeadroom, '', 0),
      ),
      metric(
        'requestsPerProxyDay',
        'Requests/proxy/day',
        formatMaybe(result.proxy.requestsPerProxyPerDay),
      ),
      metric(
        'concurrencyPerProxy',
        'Job concurrency/proxy',
        formatMaybe(result.proxy.concurrencyPerProxy),
      ),
    ]),
  );
  setHtml(
    'cost-results',
    cards([
      metric(
        'billableBandwidth',
        `Billable ${state.inputs.pricing.billingUnit}/month`,
        formatMaybe(result.cost.billingBandwidthUnitsPerMonth),
      ),
      metric('bandwidthCost', 'Bandwidth/month', formatMoneyMaybe(result.cost.bandwidthMonthly)),
      metric('proxyCost', 'Static proxies/month', formatMoneyMaybe(result.cost.proxiesMonthly)),
      metric('fixedPoolCost', 'Fixed pool/month', formatMoneyMaybe(result.cost.fixedPoolMonthly)),
      metric(
        'totalCost',
        'Estimated total/month',
        formatMoneyMaybe(result.cost.totalMonthly),
        true,
      ),
    ]),
  );
  setHtml(
    'growth-results',
    `<div class="table-wrap"><table><thead><tr>${[
      documentedHeader('Month', 'Month 1 is the current baseline; compounding starts in month 2.'),
      documentedHeader('Growth factor', 'Cumulative compound multiplier relative to month 1.'),
      documentedHeader('Submissions/day', 'Projected new daily submissions after compound growth.'),
      documentedHeader(
        'Logical jobs/day',
        'Projected recurring scrape jobs after the larger submission cohorts age through the same lifecycle.',
      ),
      documentedHeader(
        'GB/month',
        'Projected retry-adjusted 30-day bandwidth at this growth level.',
      ),
      documentedHeader(
        'Static proxies',
        'Projected recommendation using the same proxy constraints and safety margin.',
      ),
      documentedHeader(
        'Monthly cost',
        'Projected bandwidth, recommended proxy, and fixed pool charges when all prices are supplied.',
      ),
    ].join('')}</tr></thead><tbody>${result.growth
      .map(
        (month) =>
          `<tr><td>${String(month.month)}</td><td>${month.factor.toFixed(3)}×</td><td>${formatNumber(month.newSubmissionsPerDay)}</td><td>${formatNumber(month.logicalJobsPerDay)}</td><td>${formatMaybe(month.adjustedGbPerMonth)}</td><td>${formatMaybe(month.recommendedProxies, '', 0)}</td><td>${formatMoneyMaybe(month.estimatedMonthlyCost)}</td></tr>`,
      )
      .join('')}</tbody></table></div>`,
  );
  setHtml(
    'timeline-results',
    `<div class="table-wrap"><table><thead><tr>${[
      documentedHeader(
        'Day',
        'Launch day in the selected forward simulation, not a historical production date.',
      ),
      documentedHeader(
        'Phase',
        'Ramp means age cohorts are still filling; steady means recurring polling work has reached its plateau.',
      ),
      documentedHeader(
        'Active',
        'Submissions inside any enabled lifecycle stage, including dormant ones.',
      ),
      documentedHeader('Polled', 'Submissions currently in stages that schedule scrape jobs.'),
      documentedHeader(
        'Logical jobs',
        'Scheduled URL scrapes produced by all populated age cohorts that day.',
      ),
      documentedHeader(
        'HTTP · with retries',
        'Expected outbound requests after fan-out and retry amplification.',
      ),
    ].join('')}</tr></thead><tbody>${result.timeline
      .map(
        (point) =>
          `<tr><td>${String(point.day)}</td><td>${point.phase}</td><td>${formatNumber(point.activeSubmissions)}</td><td>${formatNumber(point.polledSubmissions)}</td><td>${formatNumber(point.scrapeJobs)}</td><td>${formatMaybe(point.adjustedHttpRequests)}</td></tr>`,
      )
      .join('')}</tbody></table></div>`,
  );
}

function capacityWorkloadStatus(state: CapacityState): string {
  const summary = state.result.capacityWorkload;
  if (!summary.sustainableJobsPerDay.computable) {
    return `<div class="capacity-status unavailable-capacity"><strong>Capacity unavailable</strong><p>${escapeHtml(summary.sustainableJobsPerDay.reason)}. Supply the missing measurement before relying on a maximum submission rate.</p></div>`;
  }

  const current = formatNumber(summary.currentJobsPerDay);
  const capacity = formatNumber(summary.sustainableJobsPerDay.value);
  if (summary.status === 'over-capacity') {
    const over = summary.overCapacityJobsPerDay.computable
      ? formatNumber(summary.overCapacityJobsPerDay.value)
      : 'unknown';
    return `<div class="capacity-status over-capacity"><strong>Current workload exceeds sustainable capacity</strong><p>The configured lifecycle produces ${current} jobs/day, while current infrastructure sustains approximately ${capacity}. Reduce workload or add capacity for the ${over} jobs/day shortfall.</p></div>`;
  }
  if (summary.status === 'at-capacity') {
    return `<div class="capacity-status at-capacity"><strong>Current workload exactly matches modeled capacity</strong><p>The lifecycle produces ${current} jobs/day and leaves zero modeled headroom.</p></div>`;
  }

  const headroom = summary.headroomJobsPerDay.computable
    ? formatNumber(summary.headroomJobsPerDay.value)
    : 'unknown';
  const lowUtilization = summary.utilization.computable && summary.utilization.value < 0.25;
  return `<div class="capacity-status within-capacity"><strong>Current workload is within modeled capacity</strong><p>The lifecycle produces ${current} jobs/day against approximately ${capacity} jobs/day of sustainable infrastructure capacity, leaving ${headroom} jobs/day of headroom.${lowUtilization ? ' Low utilization indicates available headroom; it is not a recommendation to scale down.' : ''}</p></div>`;
}

function systemConstraintLabel(constraint: SystemCapacityConstraintKind): string {
  const labels = {
    'worker-concurrency': 'Worker concurrency',
    'worker-job-target': 'Worker job admission',
    'worker-http-egress': 'Worker HTTP egress',
    'proxy-concurrency': 'Proxy concurrency',
    'proxy-http-rpm': 'Proxy HTTP RPM',
    'proxy-monthly-bandwidth': 'Proxy monthly bandwidth',
  } as const;
  return labels[constraint];
}

function renderFindings(state: CapacityState): void {
  setHtml(
    'findings-results',
    state.result.findings.length === 0
      ? '<p class="empty-state">No model findings.</p>'
      : state.result.findings
          .map((finding) => {
            const documentation = FINDING_DOCUMENTATION[finding.code];
            return `<article class="finding ${finding.severity}">
                <span>${finding.severity}</span>
                <div>
                  <strong>${escapeHtml(documentation.title)}</strong>
                  <p><b>Observed:</b> ${escapeHtml(finding.detail)}</p>
                  <p><b>Why it matters:</b> ${escapeHtml(documentation.why)}</p>
                  <p class="finding-action"><b>Consider:</b> ${escapeHtml(documentation.action)}</p>
                </div>
              </article>`;
          })
          .join(''),
  );
}

function renderProvenance(state: CapacityState): void {
  setHtml(
    'provenance-results',
    Object.entries(state.result.provenance)
      .map(
        ([path, provenance]) =>
          `<div class="provenance-row"><div><strong>${escapeHtml(PROVENANCE_INPUT_LABELS[path] ?? path)}</strong><code>${escapeHtml(path)}</code></div>${provenanceBadge(provenance)}</div>`,
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

interface ResultCard {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly primary: boolean;
}

function metric(key: string, label: string, value: string, primary = false): ResultCard {
  return { key, label, value, primary };
}

function cards(items: readonly ResultCard[]): string {
  return items
    .map(
      ({ key, label, value, primary }) =>
        `<div class="result-card${primary ? ' primary' : ''}"><span class="result-label">${escapeHtml(label)}${infoTip(METRIC_DOCUMENTATION[key] ?? 'Supporting planning metric.', label)}</span><strong>${value}</strong></div>`,
    )
    .join('');
}

function documentedHeader(label: string, explanation: string): string {
  return `<th>${escapeHtml(label)}${infoTip(explanation, label)}</th>`;
}

function infoTip(explanation: string, label: string): string {
  return `<button type="button" class="info-tip" aria-label="About ${escapeHtml(label)}">i<span class="info-popover" role="tooltip">${escapeHtml(explanation)}</span></button>`;
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
  return `<span class="unavailable" tabindex="0" aria-label="Unavailable: ${escapeHtml(reason)}">Unavailable<span class="info-popover unavailable-popover" role="tooltip">This result is unavailable because ${escapeHtml(reason)}. Supply the missing input rather than treating this as zero.</span></span>`;
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
