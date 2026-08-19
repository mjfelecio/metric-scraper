import { type BenchmarkSummary } from './summary.js';
import { type ComparisonRow } from './types.js';

/**
 * Renders the human answer.
 *
 * Structured around the seven questions the experiment was commissioned to
 * answer, in that order, so the report can be read by someone deciding whether
 * to pay for a bigger run — not by someone who already knows the codebase.
 *
 * Where the data does not support an answer it says so. "Unavailable" is a
 * legitimate finding here; a plausible-looking invented number is not.
 */
export function renderReport(summary: BenchmarkSummary, rows: readonly ComparisonRow[]): string {
  const lines: string[] = [];

  lines.push('# Apify vs. local TikTok scraper', '');
  lines.push(`Generated: ${summary.generatedAt}`);
  lines.push(`Mode: **${summary.mode}**`);
  lines.push(`Actor: \`${summary.actor.id}\`` + renderRunSuffix(summary));
  lines.push('');

  lines.push('## Verdict', '');
  lines.push(...renderVerdict(summary));
  lines.push('');

  lines.push('## 1. Did Apify return the same rounded view values?', '');
  lines.push(...renderViewAgreement(summary));
  lines.push('');

  lines.push('## 2. Did it return more granular views for any 10K+ or 1M+ sample?', '');
  lines.push(...renderGranularity(summary));
  lines.push('');

  lines.push('## 3. Are likes, comments, shares, saves, handle and bio more complete?', '');
  lines.push(...renderCompleteness(summary, rows));
  lines.push('');

  lines.push('## 4. What failed for either source?', '');
  lines.push(...renderFailures(rows));
  lines.push('');

  lines.push('## 5. What did the run cost?', '');
  lines.push(...renderCost(summary));
  lines.push('');

  lines.push('## 6. What bandwidth was observed, and projected?', '');
  lines.push(...renderBandwidth(summary));
  lines.push('');

  lines.push('## 7. Is there evidence to justify going further?', '');
  lines.push(...renderRecommendation(summary));
  lines.push('');

  lines.push('## Per-video detail', '');
  lines.push(...renderRowTable(rows));
  lines.push('');

  lines.push('## Caveats', '');
  for (const caveat of summary.caveats) lines.push(`- ${caveat}`);
  lines.push('');

  lines.push('## Reproducing this run', '');
  lines.push(...renderReproduction(summary));
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function renderRunSuffix(summary: BenchmarkSummary): string {
  if (summary.actor.runId === null) return ' (no run started)';
  return ` — run \`${summary.actor.runId}\`, status \`${summary.actor.terminalStatus ?? 'unknown'}\``;
}

function renderVerdict(summary: BenchmarkSummary): string[] {
  if (summary.mode === 'dry-run') {
    return [
      'This was a **dry run**. No Apify request was made, nothing was charged, and no',
      'Apify data exists to compare. Re-run with `--execute` to answer the questions below.',
    ];
  }

  const { viewGranularity: views, results } = summary;
  if (results.bothSucceeded === 0) {
    return ['No video was read successfully by both sources, so no comparison was possible.'];
  }

  if (views.apifyMoreGranular === 0) {
    return [
      `Across ${results.bothSucceeded} comparable video(s), Apify returned **no view count with`,
      'lower-order detail** that our own scraper lacked. On this sample Apify is reading the',
      'same public, rounded numbers we already read — it is not a source of finer view data.',
    ];
  }

  return [
    `Apify returned a **more granular view count on ${views.apifyMoreGranular} of`,
    `${results.bothSucceeded}** comparable video(s)` +
      (views.apifyMoreGranularAbove1m > 0
        ? `, including ${views.apifyMoreGranularAbove1m} in the 1M+ band where public rounding is coarsest.`
        : '.'),
    '',
    'More granular is **not** the same as exact: this run has no ground truth, so the finer',
    'number is evidence worth a larger experiment, not a verified true view count.',
  ];
}

function renderViewAgreement(summary: BenchmarkSummary): string[] {
  const views = summary.agreement.find((entry) => entry.metric === 'views');
  if (views === undefined || views.comparable === 0) {
    return ['No video had a view count from both sources.'];
  }
  return [
    `- Comparable videos: **${views.comparable}**`,
    `- Identical view counts: **${views.identical}**`,
    `- Differing view counts: **${views.differing}**`,
    `- Largest absolute difference: ${formatNumber(views.maxAbsoluteDelta)}`,
  ];
}

function renderGranularity(summary: BenchmarkSummary): string[] {
  const views = summary.viewGranularity;
  const lines = [
    `- Samples with 10,000+ local views: **${views.samplesAbove10k}**` +
      (views.samplesAbove10k === 0 ? ' — this band was not tested' : ''),
    `- …of which Apify was more granular: **${views.apifyMoreGranularAbove10k}**`,
    `- Samples with 1,000,000+ local views: **${views.samplesAbove1m}**` +
      (views.samplesAbove1m === 0 ? ' — this band was not tested' : ''),
    `- …of which Apify was more granular: **${views.apifyMoreGranularAbove1m}**`,
    '',
    'Precision bands are the rounding *commonly observed* on public TikTok pages',
    '(unit below 10K, 100s from 10K, 100,000s from 1M). TikTok does not document these as a',
    'stable contract, and trailing zeros alone never prove a value was rounded.',
  ];
  return lines;
}

function renderCompleteness(summary: BenchmarkSummary, rows: readonly ComparisonRow[]): string[] {
  const lines = [
    '| Metric | Comparable | Identical | Differing | Only local | Only Apify |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const entry of summary.agreement) {
    lines.push(
      `| ${entry.metric} | ${entry.comparable} | ${entry.identical} | ${entry.differing} | ` +
        `${entry.onlyLocal} | ${entry.onlyApify} |`,
    );
  }

  const apifyBios = rows.filter(
    (row) => row.apify.ok && row.apify.metrics.authorBio !== null,
  ).length;
  const apifyHandles = rows.filter(
    (row) => row.apify.ok && row.apify.metrics.authorHandle !== null,
  ).length;
  const localHandles = rows.filter(
    (row) => row.local.ok && row.local.metrics.authorHandle !== null,
  ).length;

  lines.push('');
  lines.push(`- Author handle present — local: **${localHandles}**, Apify: **${apifyHandles}**`);
  lines.push(
    `- Author bio/signature present — local: **0** (the local scraper does not collect it), ` +
      `Apify: **${apifyBios}**`,
  );
  return lines;
}

function renderFailures(rows: readonly ComparisonRow[]): string[] {
  const failures = rows.filter((row) => !row.local.ok || !row.apify.ok);
  if (failures.length === 0) return ['Both sources returned a result for every requested video.'];

  const lines: string[] = [];
  for (const row of failures) {
    if (!row.local.ok) lines.push(`- \`${row.videoId}\` local: ${row.local.error ?? 'unknown'}`);
    if (!row.apify.ok) lines.push(`- \`${row.videoId}\` Apify: ${row.apify.error ?? 'unknown'}`);
  }
  return lines;
}

function renderCost(summary: BenchmarkSummary): string[] {
  const { economics } = summary.economics;
  const lines = [
    `- Actual run cost: **${formatUsd(economics.usageTotalUsd)}**`,
    `- Successful Apify results: **${summary.economics.successfulApifyResults}**`,
    `- Cost per successful video: **${formatUsd(summary.economics.apifyCostPerSuccessUsd, 6)}**`,
    `- Pricing model: ${economics.pricingModel ?? '_unavailable_'}`,
    `- Actor build: ${economics.build ?? '_unavailable_'}`,
    `- Run duration: ${economics.runDurationMs === null ? '_unavailable_' : `${economics.runDurationMs} ms`}`,
  ];

  if (economics.chargedEventCounts !== null) {
    lines.push('- Charged events:');
    for (const [event, count] of Object.entries(economics.chargedEventCounts)) {
      lines.push(`  - \`${event}\`: ${count}`);
    }
  } else {
    lines.push('- Charged events: _unavailable_');
  }

  lines.push('');
  lines.push('Projected cost, extrapolated linearly from the measured cost per successful video.');
  lines.push(
    '**These are projections, not quotes** — they assume the same pricing model, the same',
  );
  lines.push('success rate and no volume discount.');
  lines.push('');
  lines.push('| Videos | Projected Apify cost |', '| ---: | ---: |');
  for (const projection of summary.economics.projections) {
    lines.push(
      `| ${projection.videos.toLocaleString('en-US')} | ${formatUsd(projection.apifyCostUsd)} |`,
    );
  }

  if (summary.economics.unavailable.length > 0) {
    lines.push('');
    lines.push(
      `Not reported by the API for this run: ${summary.economics.unavailable
        .map((field) => `\`${field}\``)
        .join(', ')}.`,
    );
  }
  return lines;
}

function renderBandwidth(summary: BenchmarkSummary): string[] {
  const { economics } = summary.economics;
  return [
    `- Apify server-side received: ${formatBytes(economics.netRxBytes)}`,
    `- Apify server-side transmitted: ${formatBytes(economics.netTxBytes)}`,
    `- Apify bytes per successful video: ${formatBytes(summary.economics.apifyBytesPerSuccess)}`,
    `- Local response bytes (this benchmark's own decorator): ${formatBytes(economics.localResponseBytes)}`,
    `- Local bytes per successful video: ${formatBytes(summary.economics.localBytesPerSuccess)}`,
    '',
    'These two numbers are **not** the same quantity and must not be added together or',
    "compared as a like-for-like bill. Apify's figures are traffic on Apify's own servers,",
    'already inside the per-result price. The local figure is traffic that would be billed by',
    'our proxy provider, and it is a body-plus-headers estimate rather than true socket bytes',
    '(TLS framing and compression are invisible from the client).',
    '',
    '| Videos | Projected Apify bytes | Projected local bytes |',
    '| ---: | ---: | ---: |',
    ...summary.economics.projections.map(
      (projection) =>
        `| ${projection.videos.toLocaleString('en-US')} | ${formatBytes(projection.apifyBytes)} | ` +
        `${formatBytes(projection.localBytes)} |`,
    ),
  ];
}

function renderRecommendation(summary: BenchmarkSummary): string[] {
  if (summary.mode === 'dry-run') {
    return ['Not applicable: no data was gathered.'];
  }

  const views = summary.viewGranularity;
  if (summary.results.bothSucceeded === 0) {
    return [
      'No. Nothing was successfully compared, so this run is evidence about the harness, not',
      'about Apify. Fix the failures listed above and re-run before drawing any conclusion.',
    ];
  }

  if (views.apifyMoreGranular === 0 && views.samplesAbove1m === 0) {
    return [
      '**Inconclusive.** Apify matched our own values on every comparable video, but the sample',
      'contained no 1M+ post — the band where public rounding is coarsest and where a paid',
      'source would have to earn its keep. A 12–20 URL set covering <10K, 10K–999,999 and 1M+',
      'would settle it; that run needs explicit approval because it costs money.',
    ];
  }

  if (views.apifyMoreGranular === 0) {
    return [
      '**No.** Apify returned the same public values we already collect, including in the',
      'high-view bands, so on this evidence it buys no additional view precision. Any case for',
      'it would have to rest on reliability or on fields we do not collect, not on granularity.',
    ];
  }

  return [
    '**Yes — for another experiment, not for a production integration.** Apify returned finer',
    'view values on at least one sample, which is worth confirming on a 12–20 URL set spanning',
    'all three view bands and both videos and photo posts. Nothing here justifies making Apify',
    'a production provider or fallback: that would need a ground-truth comparison and a cost',
    'model at real volume.',
  ];
}

function renderRowTable(rows: readonly ComparisonRow[]): string[] {
  if (rows.length === 0) return ['_No rows._'];

  const lines = [
    '| Video | Local views | Apify views | Δ views | More granular? | Local ms | Apify ms |',
    '| --- | ---: | ---: | ---: | :---: | ---: | ---: |',
  ];
  for (const row of rows) {
    lines.push(
      `| \`${row.videoId}\` (${row.kind}) | ${formatNumber(row.deltas.views.local)} | ` +
        `${formatNumber(row.deltas.views.apify)} | ${formatSigned(row.deltas.views.signed)} | ` +
        `${formatTriState(row.viewPrecision.apifyMoreGranular)} | ` +
        `${formatNumber(row.local.latencyMs)} | ${formatNumber(row.apify.latencyMs)} |`,
    );
  }
  return lines;
}

function renderReproduction(summary: BenchmarkSummary): string[] {
  const flags = Object.entries(summary.actor.featureFlags)
    .map(([key, value]) => `  - \`${key}\`: ${JSON.stringify(value)}`)
    .sort();

  return [
    `- Input file: \`${summary.input.path}\``,
    `- Candidates: ${summary.input.candidates}, accepted: ${summary.input.accepted}, ` +
      `rejected: ${summary.input.rejected}, duplicates collapsed: ${summary.input.duplicatesCollapsed}`,
    `- Billable unique URLs: **${summary.input.billableUrls}** (cap ${summary.caps.maxUrls})`,
    `- Charge cap: $${summary.caps.maxChargeUsd}`,
    `- Actor path id: \`${summary.actor.pathId}\``,
    `- Dataset: ${summary.actor.datasetId === null ? '_none_' : `\`${summary.actor.datasetId}\``}`,
    '- Actor input flags:',
    ...(flags.length > 0 ? flags : ['  - _none recorded_']),
  ];
}

function formatNumber(value: number | null): string {
  return value === null ? '—' : value.toLocaleString('en-US');
}

function formatSigned(value: number | null): string {
  if (value === null) return '—';
  return value > 0 ? `+${value.toLocaleString('en-US')}` : value.toLocaleString('en-US');
}

function formatTriState(value: boolean | null): string {
  if (value === null) return '—';
  return value ? 'yes' : 'no';
}

function formatUsd(value: number | null, digits = 4): string {
  return value === null ? '_unavailable_' : `$${value.toFixed(digits)}`;
}

function formatBytes(value: number | null): string {
  if (value === null) return '_unavailable_';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}
