/**
 * Diagnostics for "is this view count rounded, and is the other one finer?"
 *
 * Everything here is *evidence*, never proof. TikTok has never published its
 * display-rounding rules as a contract, and a value ending in zeros may simply
 * be a video with a round number of views. So the vocabulary is deliberately
 * hedged — `quantized`, `rounded display value`, `more granular` — and nothing
 * in this module ever concludes that a number is exact. Establishing that would
 * need ground truth the benchmark does not have (creator analytics, say).
 */

/** The observed public-display steps, by magnitude. Diagnostic only. */
export const OBSERVED_DISPLAY_STEPS = [
  { minValue: 1_000_000, step: 100_000 },
  { minValue: 10_000, step: 100 },
  { minValue: 0, step: 1 },
] as const;

/**
 * The display step commonly observed at this magnitude.
 *
 * Not a documented TikTok contract. Used only to say "this value is consistent
 * with the rounding we usually see", never to assert what the true count is.
 */
export function expectedDisplayStep(value: number): number {
  for (const band of OBSERVED_DISPLAY_STEPS) {
    if (value >= band.minValue) return band.step;
  }
  return 1;
}

/** Largest power of ten (up to 100,000) that divides `value`. `0` divides by all. */
export function resolutionOf(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) return 1;
  if (value === 0) return 1;
  let step = 1;
  for (const candidate of [10, 100, 1_000, 10_000, 100_000]) {
    if (value % candidate !== 0) break;
    step = candidate;
  }
  return step;
}

export interface ViewPrecisionDiagnosis {
  /** Finest power-of-ten resolution each value actually carries. */
  readonly localResolution: number | null;
  readonly apifyResolution: number | null;
  /** The step usually seen at this magnitude, from whichever value is known. */
  readonly expectedStep: number | null;
  /** Local value is a clean multiple of the step usually seen at its size. */
  readonly localLooksQuantized: boolean | null;
  readonly apifyLooksQuantized: boolean | null;
  /**
   * Apify carries lower-order detail the local public value does not.
   *
   * True only when Apify's value resolves finer AND the two are close enough
   * that the finer one plausibly describes the same measurement — a wholly
   * different number is a disagreement, not extra precision.
   */
  readonly apifyMoreGranular: boolean | null;
  /** Set when a claim could not be made, e.g. one source failed. */
  readonly note: string | null;
}

/**
 * How far apart two view counts may be while still being read as the same
 * measurement at different precisions, expressed as a share of the coarser
 * value's own rounding step.
 *
 * At 1.0, `1,200,000` vs `1,234,567` counts as extra precision (the gap is
 * inside one 100,000 step) while `1,200,000` vs `1,930,412` does not.
 */
const SAME_MEASUREMENT_TOLERANCE = 1;

export function diagnoseViewPrecision(
  localViews: number | null,
  apifyViews: number | null,
): ViewPrecisionDiagnosis {
  if (apifyViews === null) {
    return localViews === null
      ? empty('neither source reported a view count')
      : { ...empty('Apify did not report a view count'), ...localOnly(localViews) };
  }
  if (localViews === null) {
    return { ...empty('the local scraper did not report a view count'), ...apifyOnly(apifyViews) };
  }

  const localResolution = resolutionOf(localViews);
  const apifyResolution = resolutionOf(apifyViews);
  // Taken from the local value: it is the public display number whose rounding
  // is the thing under investigation.
  const expectedStep = expectedDisplayStep(localViews);

  const coarserStep = Math.max(localResolution, apifyResolution);
  const withinSameMeasurement =
    Math.abs(localViews - apifyViews) <= coarserStep * SAME_MEASUREMENT_TOLERANCE;

  return {
    localResolution,
    apifyResolution,
    expectedStep,
    localLooksQuantized: localViews % expectedStep === 0,
    apifyLooksQuantized: apifyViews % expectedDisplayStep(apifyViews) === 0,
    apifyMoreGranular: apifyResolution < localResolution && withinSameMeasurement,
    note:
      apifyResolution < localResolution && !withinSameMeasurement
        ? 'Apify resolves finer but the values differ by more than one rounding step, ' +
          'so this is a disagreement rather than added precision'
        : null,
  };
}

function empty(note: string): ViewPrecisionDiagnosis {
  return {
    localResolution: null,
    apifyResolution: null,
    expectedStep: null,
    localLooksQuantized: null,
    apifyLooksQuantized: null,
    apifyMoreGranular: null,
    note,
  };
}

function localOnly(views: number): Partial<ViewPrecisionDiagnosis> {
  return {
    localResolution: resolutionOf(views),
    expectedStep: expectedDisplayStep(views),
    localLooksQuantized: views % expectedDisplayStep(views) === 0,
  };
}

function apifyOnly(views: number): Partial<ViewPrecisionDiagnosis> {
  return {
    apifyResolution: resolutionOf(views),
    apifyLooksQuantized: views % expectedDisplayStep(views) === 0,
  };
}
