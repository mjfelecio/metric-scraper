import path from 'node:path';

import { type Logger } from '../core/logging/logger.js';
import { type BandwidthView } from '../core/metrics/bandwidth.js';
import { type RunSummary } from '../core/models/run-summary.js';
import { type CycleSummary } from '../core/models/session-summary.js';
import {
  appendBaseline as appendBaselineToDisk,
  type BandwidthBaselineRecord,
  buildBaselineRecord,
  readBaselines as readBaselinesFromDisk,
  summarizeBaselines,
  type ReadBaselinesResult,
} from '../infrastructure/output/bandwidth-baselines.js';

import { bandwidthViewFromCycles } from './bandwidth-view.js';
import { cycleRunId } from './scrape-session.js';
import { type RunStateDto } from './types.js';

const BASELINE_FILE_NAME = 'bandwidth-baselines.jsonl';

export function baselinePath(outputDir: string): string {
  return path.join(outputDir, BASELINE_FILE_NAME);
}

/**
 * Guards an async write against a slower, older call clobbering a faster,
 * newer one's result.
 *
 * R8/Important: `refreshBandwidth` runs fire-and-forget once per cycle,
 * reads a file, and ends by assigning `state.bandwidth` with no ordering
 * guard of its own. If cycle N's read resolves after cycle N+1's, the stale
 * read must not overwrite the fresh one.
 *
 * One instance is held for the whole life of a run. `begin()` is called
 * synchronously right before starting the async work; the function it
 * returns is checked immediately before the write and is `true` only if
 * nothing newer has begun in the meantime — whichever call *started* last
 * always wins, regardless of which one *finishes* last.
 */
export class LatestWins {
  private seq = 0;
  private tail: Promise<void> = Promise.resolve();

  begin(): () => boolean {
    const mine = (this.seq += 1);
    return () => mine === this.seq;
  }

  /**
   * Runs cycle bookkeeping in call order while assigning freshness at enqueue
   * time, before any append or read can yield. Serializing also keeps JSONL
   * records in cycle order rather than whichever filesystem call finishes first.
   */
  enqueue(work: (isLatest: () => boolean) => Promise<void>): Promise<void> {
    const isLatest = this.begin();
    const current = this.tail.then(() => work(isLatest));
    this.tail = current.catch(() => {});
    return current;
  }
}

export interface BandwidthBaselineDeps {
  readonly outputDir: string;
  readonly logger: Logger;
  /**
   * Overridable for tests — see `LatestWins`'s ordering-guard test, which
   * needs two overlapping reads it can resolve in a chosen order. Defaults to
   * the real disk read.
   */
  readonly readBaselines?: ((path_: string) => Promise<ReadBaselinesResult>) | undefined;
  /** Overridable for ordering tests. Defaults to the append-only disk writer. */
  readonly appendBaseline?:
    ((path_: string, record: BandwidthBaselineRecord) => Promise<void>) | undefined;
}

/**
 * Appends one finished run or cycle's bandwidth to the cross-run baseline
 * history.
 *
 * Skipped entirely when `buildBaselineRecord` returns `null` — METRICS_BANDWIDTH
 * off, or on but nothing was ever measured. Either way, an unmeasured run
 * entering the history as a zero would corrupt every later average. A
 * failure to append must not fail the run, matching `persistSummary`.
 */
export async function appendBandwidthBaseline(
  summary: RunSummary,
  deps: BandwidthBaselineDeps,
): Promise<void> {
  const record = buildBaselineRecord(summary);
  if (record === null) return;

  const path_ = baselinePath(deps.outputDir);
  try {
    await (deps.appendBaseline ?? appendBaselineToDisk)(path_, record);
  } catch (error) {
    deps.logger.warn(
      { path: path_, message: error instanceof Error ? error.message : String(error) },
      'could not append bandwidth baseline',
    );
  }
}

/**
 * Sets `state.bandwidth` from a freshly computed `current` view, reading the
 * baseline history off disk only when there is something to pair it with.
 *
 * `current === null` (measurement off, or nothing measured yet) skips the
 * read entirely — that state can never have a baseline worth showing either.
 *
 * `excludeRunId` is passed through to `summarizeBaselines` so a run's own
 * just-appended line (see `appendBandwidthBaseline`) is excluded from its
 * own baseline (R2/R6). For a continuous session this must be the *cycle's*
 * own run id (`cycleRunId(sessionId, cycle)`), not the session id — see R8:
 * cycle lines are appended as `${sessionId}-cycle-NNN`, which never equals
 * the bare session id, so passing the session id here would silently fail to
 * exclude anything and let a cycle become its own baseline.
 *
 * `guard` protects the final assignment against a stale, out-of-order
 * resolution — see `LatestWins`.
 */
export async function refreshBandwidth(
  state: RunStateDto,
  current: BandwidthView | null,
  excludeRunId: string,
  guard: LatestWins,
  deps: BandwidthBaselineDeps,
): Promise<void> {
  const isLatest = guard.begin();
  await refreshBandwidthIfLatest(state, current, excludeRunId, isLatest, deps);
}

async function refreshBandwidthIfLatest(
  state: RunStateDto,
  current: BandwidthView | null,
  excludeRunId: string,
  isLatest: () => boolean,
  deps: BandwidthBaselineDeps,
): Promise<void> {
  if (current === null) {
    if (isLatest()) state.bandwidth = null;
    return;
  }

  const read = deps.readBaselines ?? readBaselinesFromDisk;
  const path_ = baselinePath(deps.outputDir);
  let result: ReadBaselinesResult;
  try {
    result = await read(path_);
  } catch (error) {
    deps.logger.warn(
      { path: path_, message: error instanceof Error ? error.message : String(error) },
      'could not read bandwidth baseline history',
    );
    if (isLatest()) state.bandwidth = null;
    return;
  }
  if (result.skippedLines > 0) {
    deps.logger.warn(
      { path: path_, skipped_lines: result.skippedLines },
      'skipped corrupt bandwidth baseline lines',
    );
  }
  if (!isLatest()) return;
  state.bandwidth = { current, baseline: summarizeBaselines(result.records, excludeRunId) };
}

/**
 * Per-cycle bandwidth bookkeeping for a continuous session (R8): appends the
 * cycle's own line to the baseline history (if it measured anything), then
 * refreshes `state.bandwidth` from the cumulative view across every cycle so
 * far, excluding this cycle's own just-appended line from its baseline.
 *
 * A cycle whose `summary` is `null` (it threw before producing one) has
 * nothing to append, but the cumulative refresh still runs — `cycles` may
 * already hold earlier cycles worth showing.
 */
export async function recordCycleBandwidth(
  state: RunStateDto,
  cycles: readonly CycleSummary[],
  cycle: CycleSummary,
  sessionId: string,
  guard: LatestWins,
  deps: BandwidthBaselineDeps,
): Promise<void> {
  await guard.enqueue(async (isLatest) => {
    if (cycle.summary !== null) {
      await appendBandwidthBaseline(cycle.summary, deps);
    }

    const current = bandwidthViewFromCycles(cycles);
    await refreshBandwidthIfLatest(
      state,
      current,
      cycleRunId(sessionId, cycle.cycle),
      isLatest,
      deps,
    );
  });
}
