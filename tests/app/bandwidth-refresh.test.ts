import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendBandwidthBaseline,
  LatestWins,
  recordCycleBandwidth,
  refreshBandwidth,
} from '../../src/app/bandwidth-refresh.js';
import { bandwidthViewFromCycles } from '../../src/app/bandwidth-view.js';
import { cycleRunId } from '../../src/app/scrape-session.js';
import { type RunStateDto } from '../../src/app/types.js';
import { nullLogger } from '../../src/core/logging/logger.js';
import { type BandwidthView } from '../../src/core/metrics/bandwidth.js';
import { type RunSummary } from '../../src/core/models/run-summary.js';
import { type CycleSummary } from '../../src/core/models/session-summary.js';
import { type ReadBaselinesResult } from '../../src/infrastructure/output/bandwidth-baselines.js';

/** Only `run_id` / `finished_at` / `bandwidth` matter to the functions under test. */
function summaryWith(runId: string, bandwidth: RunSummary['bandwidth']): RunSummary {
  return {
    run_id: runId,
    finished_at: `${runId}-finished-at`,
    bandwidth,
  } as unknown as RunSummary;
}

function cycleWith(cycle: number, runId: string, bandwidth: RunSummary['bandwidth']): CycleSummary {
  return {
    cycle,
    scheduled_at: '2026-08-20T00:00:00.000Z',
    started_at: '2026-08-20T00:00:00.000Z',
    finished_at: '2026-08-20T00:00:01.000Z',
    lag_ms: 0,
    overran: false,
    summary: summaryWith(runId, bandwidth),
    error: null,
  };
}

function measured(totalBytes: number, requests: number): RunSummary['bandwidth'] {
  const requestBytes = Math.floor(totalBytes / 2);
  return {
    requests,
    request_bytes: requestBytes,
    response_bytes: totalBytes - requestBytes,
    total_bytes: totalBytes,
    bytes_per_request: totalBytes / requests,
  };
}

function freshState(): RunStateDto {
  return { bandwidth: null } as unknown as RunStateDto;
}

function view(requests: number, totalBytes: number): BandwidthView {
  return {
    requests,
    requestBytes: Math.floor(totalBytes / 2),
    responseBytes: totalBytes - Math.floor(totalBytes / 2),
    totalBytes,
    bytesPerRequest: requests === 0 ? null : totalBytes / requests,
    perProxy: [],
  };
}

describe('cycleRunId', () => {
  it('formats as `${sessionId}-cycle-NNN`, zero-padded to three digits', () => {
    expect(cycleRunId('session-abc', 1)).toBe('session-abc-cycle-001');
    expect(cycleRunId('session-abc', 42)).toBe('session-abc-cycle-042');
    expect(cycleRunId('session-abc', 137)).toBe('session-abc-cycle-137');
  });
});

describe('LatestWins', () => {
  it('a call that began before another loses to it', () => {
    const guard = new LatestWins();
    const older = guard.begin();
    const newer = guard.begin();

    expect(newer()).toBe(true);
    expect(older()).toBe(false);
  });

  it('a lone call always wins', () => {
    const guard = new LatestWins();
    const only = guard.begin();
    expect(only()).toBe(true);
  });
});

describe('refreshBandwidth — ordering guard (Important)', () => {
  /**
   * `onCycleEnd` fires `recordCycleBandwidth`/`refreshBandwidth`
   * fire-and-forget, once per cycle. If cycle N's read resolves after cycle
   * N+1's, the stale read must not overwrite the fresh one. This drives two
   * overlapping refreshes and resolves them out of order (the newer one
   * first) to prove the guard, not the resolution order, decides the winner.
   */
  it('a slower, older refresh resolving after a faster, newer one must not clobber it', async () => {
    const guard = new LatestWins();
    const state = freshState();

    const reads: Array<Promise<ReadBaselinesResult>> = [];
    const resolvers: Array<(value: ReadBaselinesResult) => void> = [];
    for (let i = 0; i < 2; i += 1) {
      let resolve!: (value: ReadBaselinesResult) => void;
      reads.push(new Promise<ReadBaselinesResult>((r) => (resolve = r)));
      resolvers.push(resolve);
    }
    let callIndex = 0;
    const readBaselinesFake = (): Promise<ReadBaselinesResult> => {
      const promise = reads[callIndex];
      callIndex += 1;
      if (promise === undefined) throw new Error('unexpected extra readBaselines call');
      return promise;
    };

    const deps = { outputDir: '/unused', logger: nullLogger, readBaselines: readBaselinesFake };

    // Older refresh (cycle N) begins first...
    const olderCall = refreshBandwidth(state, view(10, 10_000), 'run-a', guard, deps);
    // ...then a newer one (cycle N+1) begins before the older has resolved.
    const newerCall = refreshBandwidth(state, view(20, 20_000), 'run-b', guard, deps);

    // The newer refresh's disk read comes back first.
    const [, resolveNewer] = resolvers;
    resolveNewer?.({ records: [], skippedLines: 0 });
    await newerCall;
    expect(state.bandwidth?.current.requests).toBe(20);

    // The older refresh's disk read finally comes back — too late. It must
    // not be allowed to overwrite the fresher result already written.
    const [resolveOlder] = resolvers;
    resolveOlder?.({ records: [], skippedLines: 0 });
    await olderCall;
    expect(state.bandwidth?.current.requests).toBe(20);
  });
});

describe('recordCycleBandwidth — R8 trap: a cycle must not become its own baseline', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'metric-scraper-cycle-baseline-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('excludes the cycle that just appended its own line, leaving the previous cycle as the baseline', async () => {
    const sessionId = 'session-abc';
    const deps = { outputDir: dir, logger: nullLogger };
    const guard = new LatestWins();
    const state = freshState();

    const cycle1 = cycleWith(1, cycleRunId(sessionId, 1), measured(100_000, 100));
    await recordCycleBandwidth(state, [cycle1], cycle1, sessionId, guard, deps);

    // Only one cycle has ever finished — there is nothing to compare it to
    // yet, so there must be no baseline at all (not a self-comparison).
    expect(state.bandwidth?.baseline.baseline).toBeNull();
    expect(state.bandwidth?.current.totalBytes).toBe(100_000);

    const cycle2 = cycleWith(2, cycleRunId(sessionId, 2), measured(200_000, 100));
    await recordCycleBandwidth(state, [cycle1, cycle2], cycle2, sessionId, guard, deps);

    // The trap: `refreshBandwidth` must be told cycle 2's *own* run id
    // (`${sessionId}-cycle-002`), not the bare session id, to exclude it from
    // its own baseline. Getting this wrong makes cycle 2 its own baseline —
    // permanent 0% drift that looks like a working feature.
    expect(state.bandwidth?.baseline.baseline?.runId).toBe(cycleRunId(sessionId, 1));
    expect(state.bandwidth?.baseline.baseline?.runId).not.toBe(cycleRunId(sessionId, 2));
    expect(state.bandwidth?.baseline.baseline?.avgBytesPerRequest).toBeCloseTo(1_000); // cycle 1: 100_000 / 100
    // `current` is the cumulative view across every cycle so far (R8's
    // decision keeps this cumulative, only the *baseline exclusion* is
    // per-cycle), so it reflects both cycles' bytes.
    expect(state.bandwidth?.current.totalBytes).toBe(300_000);
  });

  it('demonstrates the trap directly: excluding by the session id instead of the cycle id fails to self-exclude', async () => {
    const sessionId = 'session-xyz';
    const deps = { outputDir: dir, logger: nullLogger };

    const cycle1 = cycleWith(1, cycleRunId(sessionId, 1), measured(50_000, 50));
    if (cycle1.summary === null) throw new Error('unreachable: cycle1.summary is never null here');
    await appendBandwidthBaseline(cycle1.summary, deps);

    // The old, buggy wiring: excluding by the bare session id. Cycle 1's
    // appended line has id `${sessionId}-cycle-001`, which never equals the
    // bare session id, so nothing is excluded and the cycle becomes its own
    // baseline.
    const buggyGuard = new LatestWins();
    const buggyState = freshState();
    await refreshBandwidth(
      buggyState,
      bandwidthViewFromCycles([cycle1]),
      sessionId,
      buggyGuard,
      deps,
    );
    expect(buggyState.bandwidth?.baseline.baseline?.runId).toBe(cycleRunId(sessionId, 1));

    // The fix: excluding by the cycle's own run id correctly finds no
    // baseline yet, since this is the only cycle so far.
    const fixedGuard = new LatestWins();
    const fixedState = freshState();
    await refreshBandwidth(
      fixedState,
      bandwidthViewFromCycles([cycle1]),
      cycleRunId(sessionId, 1),
      fixedGuard,
      deps,
    );
    expect(fixedState.bandwidth?.baseline.baseline).toBeNull();
  });

  it('a cycle that threw before producing a summary appends nothing but still refreshes the cumulative view', async () => {
    const sessionId = 'session-partial';
    const deps = { outputDir: dir, logger: nullLogger };
    const guard = new LatestWins();
    const state = freshState();

    const cycle1 = cycleWith(1, cycleRunId(sessionId, 1), measured(10_000, 10));
    await recordCycleBandwidth(state, [cycle1], cycle1, sessionId, guard, deps);

    const cycle2: CycleSummary = {
      cycle: 2,
      scheduled_at: '2026-08-20T00:00:02.000Z',
      started_at: '2026-08-20T00:00:02.000Z',
      finished_at: '2026-08-20T00:00:03.000Z',
      lag_ms: 0,
      overran: false,
      summary: null, // threw before producing one
      error: { code: 'network_error', message: 'boom' },
    };
    await recordCycleBandwidth(state, [cycle1, cycle2], cycle2, sessionId, guard, deps);

    // Cumulative view still only reflects cycle 1 — cycle 2 contributed
    // nothing (no line was appended for it: `buildBaselineRecord` never runs
    // without a summary). Cycle 1's own line is still the most recent thing
    // in history and is a legitimate baseline for cycle 2 to compare against
    // (cycle 2's own exclusion id never matches it, since cycle 2 never
    // appended anything).
    expect(state.bandwidth?.current.totalBytes).toBe(10_000);
    expect(state.bandwidth?.baseline.baseline?.runId).toBe(cycleRunId(sessionId, 1));
  });
});
