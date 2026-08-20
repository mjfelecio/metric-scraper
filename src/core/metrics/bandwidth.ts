/** One measured HTTP round trip, in wire bytes. */
export interface BandwidthSample {
  /** `null` for a direct request that used no proxy. */
  readonly proxyId: string | null;
  readonly host: string;
  readonly requestBytes: number;
  readonly responseBytes: number;
}

/**
 * Where the counting dispatcher reports to.
 *
 * A port rather than a concrete class so the interceptor can be tested without
 * dragging in aggregation, and so a run can discard counts entirely when
 * measurement is switched off.
 */
export interface BandwidthSink {
  record(sample: BandwidthSample): void;
}

/** Ignores everything. Used when `METRICS_BANDWIDTH` is off. */
export const nullBandwidthSink: BandwidthSink = { record: () => {} };

export interface ProxyBandwidthView {
  readonly proxyId: string | null;
  readonly requests: number;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly totalBytes: number;
}

export interface BandwidthView {
  readonly requests: number;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly totalBytes: number;
  /** `null` until at least one request has been measured. */
  readonly bytesPerRequest: number | null;
  /** `null` when this view was reconstructed without per-proxy measurements. */
  readonly perProxy: readonly ProxyBandwidthView[] | null;
}

interface Bucket {
  requests: number;
  requestBytes: number;
  responseBytes: number;
}

/** The key used for direct traffic, which has no proxy id. */
const DIRECT = '__direct__';

export class BandwidthAggregator implements BandwidthSink {
  private readonly buckets = new Map<string, Bucket>();

  record(sample: BandwidthSample): void {
    const key = sample.proxyId ?? DIRECT;
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      bucket = { requests: 0, requestBytes: 0, responseBytes: 0 };
      this.buckets.set(key, bucket);
    }
    bucket.requests += 1;
    bucket.requestBytes += sample.requestBytes;
    bucket.responseBytes += sample.responseBytes;
  }

  view(): BandwidthView {
    const perProxy: ProxyBandwidthView[] = [];
    let requests = 0;
    let requestBytes = 0;
    let responseBytes = 0;

    for (const [key, bucket] of this.buckets) {
      requests += bucket.requests;
      requestBytes += bucket.requestBytes;
      responseBytes += bucket.responseBytes;
      perProxy.push({
        proxyId: key === DIRECT ? null : key,
        requests: bucket.requests,
        requestBytes: bucket.requestBytes,
        responseBytes: bucket.responseBytes,
        totalBytes: bucket.requestBytes + bucket.responseBytes,
      });
    }

    const totalBytes = requestBytes + responseBytes;
    return {
      requests,
      requestBytes,
      responseBytes,
      totalBytes,
      bytesPerRequest: requests === 0 ? null : totalBytes / requests,
      perProxy,
    };
  }
}
