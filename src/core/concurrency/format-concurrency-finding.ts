import { type ConcurrencyFinding } from './concurrency-diagnostics.js';
import { type ConcurrencySummary } from '../models/run-summary.js';

/** Shared human wording for CLI and web consumers. */
export function formatConcurrencyFinding(
  finding: ConcurrencyFinding,
  concurrency: ConcurrencySummary,
): string {
  const { ceilings } = concurrency;
  const values = `${ceilings.configured} configured, ${ceilings.input} input, ${concurrency.achievable} achievable`;
  switch (finding.code) {
    case 'small_input':
      return `Input bounds concurrency: ${values}.`;
    case 'admission_limited':
      return `Admission pacing bounds concurrency: ${values}, admission ceiling ${ceilings.admission}.`;
    case 'proxy_capacity_limited':
      return `Proxy capacity bounds concurrency: ${values}, known capacity ${ceilings.proxy ?? 'unknown'}.`;
    case 'serialized':
      return `Concurrency underused despite queued demand: ${values}, ${concurrency.max_observed} observed${concurrency.effective < 1.5 ? '; this run was effectively sequential' : ''}.`;
    case 'proxy_capacity_unknown':
      return `Proxy capacity is unknown: ${values}; the provider reported capacity: unknown.`;
  }
}
