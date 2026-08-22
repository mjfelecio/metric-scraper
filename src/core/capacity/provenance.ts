/**
 * Where a default came from.
 *
 * The calculator ships numbers of three very different qualities — figures
 * measured from run artifacts in `output/`, figures that are somebody's
 * operating assumption, and figures nobody has ever established. Presenting
 * them identically would let an assumption acquire the authority of a
 * measurement just by sitting in the same table, so every default carries its
 * origin and the UI renders it as a badge.
 */

export type ProvenanceKind =
  /** Derived from a run artifact or from the code path itself. */
  | 'measured'
  /** A shipped configuration default — measured in the sense that it is what runs. */
  | 'config'
  /** Somebody's operating assumption. Defensible, but not observed. */
  | 'assumption'
  /** Nothing is known. The model must refuse to compute rather than invent one. */
  | 'unset';

export interface Provenance {
  readonly kind: ProvenanceKind;
  /** The artifact, source file or env var this came from. Empty only for `unset`. */
  readonly source: string;
  readonly note: string | null;
}

export function measured(source: string, note: string | null = null): Provenance {
  return { kind: 'measured', source, note };
}

export function config(source: string, note: string | null = null): Provenance {
  return { kind: 'config', source, note };
}

export function assumption(source: string, note: string | null = null): Provenance {
  return { kind: 'assumption', source, note };
}

export function unset(note: string): Provenance {
  return { kind: 'unset', source: '', note };
}

export const PROVENANCE_LABELS: Record<ProvenanceKind, string> = {
  measured: 'measured',
  config: 'shipped config',
  assumption: 'assumption',
  unset: 'not established',
};

/** `measured — output/bandwidth-baselines-tiktok.jsonl (10 runs, 400 requests)`. */
export function formatProvenance(provenance: Provenance): string {
  const label = PROVENANCE_LABELS[provenance.kind];
  const detail = [provenance.source, provenance.note].filter(
    (part) => part !== null && part !== '',
  );
  return detail.length === 0 ? label : `${label} — ${detail.join(' · ')}`;
}
