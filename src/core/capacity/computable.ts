/**
 * A value that may not be derivable from the inputs, and says why.
 *
 * The capacity model is asked for numbers it frequently cannot produce: a
 * bandwidth cost with no price per GB, a proxy count with no per-proxy limit,
 * a concurrency requirement with no latency measurement. Returning `0` for
 * those would be an assertion — "this costs nothing" — which is a different
 * claim from "nobody has told me the price". `src/core/metrics/bandwidth.ts`
 * already draws that line for measured bytes (`null` until something is
 * observed, never `0`); this is the same rule with the reason kept attached,
 * because a planning tool has to be able to say what is missing.
 */

export interface Computed<T> {
  readonly computable: true;
  readonly value: T;
}

export interface NotComputable {
  readonly computable: false;
  /** Human-readable, shown verbatim in place of the number. */
  readonly reason: string;
  /** Dotted input paths the operator must fill in, e.g. `pricing.pricePerGb`. */
  readonly missing: readonly string[];
}

export type Maybe<T> = Computed<T> | NotComputable;

export function computed<T>(value: T): Computed<T> {
  return { computable: true, value };
}

export function notComputable(reason: string, missing: readonly string[] = []): NotComputable {
  return { computable: false, reason, missing };
}

/** The value, or `fallback` — for chart series and other places a number is required. */
export function valueOr<T>(maybe: Maybe<T>, fallback: T): T {
  return maybe.computable ? maybe.value : fallback;
}

export function mapMaybe<A, B>(maybe: Maybe<A>, project: (value: A) => B): Maybe<B> {
  return maybe.computable ? computed(project(maybe.value)) : maybe;
}

/**
 * Combines two maybes, propagating the first failure **with its own reason**.
 *
 * Replacing an upstream reason with a generic one loses the only thing that
 * makes the failure actionable: "bandwidth cost needs bytes per HTTP request"
 * tells the operator which field to fill, "cost unavailable" does not.
 */
export function combine2<A, B, R>(a: Maybe<A>, b: Maybe<B>, project: (a: A, b: B) => R): Maybe<R> {
  if (!a.computable) return a;
  if (!b.computable) return b;
  return computed(project(a.value, b.value));
}
