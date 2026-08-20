import { describe, expect, it } from 'vitest';

import { BandwidthAggregator } from '../../src/core/metrics/bandwidth.js';

describe('BandwidthAggregator', () => {
  it('sums request and response bytes across samples', () => {
    const agg = new BandwidthAggregator();
    agg.record({ proxyId: 'p1', host: 'www.tiktok.com', requestBytes: 100, responseBytes: 900 });
    agg.record({ proxyId: 'p1', host: 'www.tiktok.com', requestBytes: 150, responseBytes: 1850 });

    const view = agg.view();
    expect(view.requests).toBe(2);
    expect(view.requestBytes).toBe(250);
    expect(view.responseBytes).toBe(2750);
    expect(view.totalBytes).toBe(3000);
    expect(view.bytesPerRequest).toBe(1500);
  });

  it('reports bytesPerRequest as null before anything is measured', () => {
    // Zero would assert the run used no bandwidth, which is a different claim.
    expect(new BandwidthAggregator().view().bytesPerRequest).toBeNull();
  });

  it('splits totals per proxy', () => {
    const agg = new BandwidthAggregator();
    agg.record({ proxyId: 'p1', host: 'h', requestBytes: 10, responseBytes: 90 });
    agg.record({ proxyId: 'p2', host: 'h', requestBytes: 20, responseBytes: 180 });
    agg.record({ proxyId: 'p1', host: 'h', requestBytes: 10, responseBytes: 90 });

    const byId = new Map(agg.view().perProxy.map((row) => [row.proxyId, row]));
    expect(byId.get('p1')?.requests).toBe(2);
    expect(byId.get('p1')?.totalBytes).toBe(200);
    expect(byId.get('p2')?.requests).toBe(1);
    expect(byId.get('p2')?.totalBytes).toBe(200);
  });

  it('keeps direct (unproxied) traffic under a null proxy id', () => {
    const agg = new BandwidthAggregator();
    agg.record({ proxyId: null, host: 'h', requestBytes: 5, responseBytes: 15 });

    const direct = agg.view().perProxy.find((row) => row.proxyId === null);
    expect(direct?.requests).toBe(1);
    expect(direct?.totalBytes).toBe(20);
  });
});
