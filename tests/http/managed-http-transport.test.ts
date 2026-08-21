import { createServer, type Socket } from 'node:net';
import { once } from 'node:events';

import { describe, expect, it } from 'vitest';

import { createManagedHttpTransport } from '../../src/app/composition.js';
import { loadConfig } from '../../src/config/env.js';
import { BandwidthAggregator } from '../../src/core/metrics/bandwidth.js';

describe('managed HTTP transport', () => {
  it('reuses a warm direct connection across cycle clients and switches bandwidth sinks', async () => {
    const sockets = new Set<Socket>();
    const seenRequest = new WeakSet<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('data', () => {
        const cold = !seenRequest.has(socket);
        seenRequest.add(socket);
        setTimeout(
          () =>
            socket.write(
              'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok',
            ),
          cold ? 200 : 0,
        );
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing test port');

    const config = loadConfig({ env: { METRICS_BANDWIDTH: 'true' }, dotenv: false });
    const transport = createManagedHttpTransport(config);
    const firstCycle = new BandwidthAggregator();
    const secondCycle = new BandwidthAggregator();
    const url = `http://127.0.0.1:${address.port}/metrics`;

    try {
      const first = await transport.clientFor(firstCycle).request({ url });
      // Let Undici return the completed request's socket to the idle pool,
      // matching the much larger boundary between real session cycles.
      await new Promise((resolve) => setImmediate(resolve));
      const second = await transport.clientFor(secondCycle).request({ url });

      expect(first.durationMs).toBeGreaterThanOrEqual(160);
      expect(first.durationMs - second.durationMs).toBeGreaterThanOrEqual(100);
      expect(sockets.size).toBe(1);
      expect(firstCycle.view().requests).toBe(1);
      expect(secondCycle.view().requests).toBe(1);
    } finally {
      await transport.close();
      if (sockets.size > 0) {
        await Promise.all([...sockets].map((socket) => once(socket, 'close')));
      }
      server.close();
      await once(server, 'close');
    }

    expect(sockets.size).toBe(0);
  });
});
