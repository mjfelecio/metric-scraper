import net from 'node:net';
import type tls from 'node:tls';
import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it } from 'vitest';

import { HttpCanaryProxyProbe } from '../../src/infrastructure/proxy/http-canary-proxy-probe.js';
import { parseProxyEntry } from '../../src/infrastructure/proxy/proxy-config.js';

/**
 * Fake proxies, driven by what they do with a CONNECT.
 *
 * A real TCP server rather than a stubbed socket, because the stages this probe
 * exists to separate — refuse the connection, answer CONNECT with a web
 * server's 400, accept it and stall — are transport behaviours, and stubbing
 * them would only assert that the stub was written to match the code.
 */
const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function listen(onConnect: (socket: net.Socket, head: string) => void): Promise<number> {
  const server = net.createServer((socket) => {
    let head = '';
    socket.on('error', () => {
      /* a probe that gives up mid-handshake is the normal case here */
    });
    socket.on('data', (chunk) => {
      head += chunk.toString('latin1');
      if (head.includes('\r\n\r\n')) onConnect(socket, head);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as net.AddressInfo).port;
}

function target(port: number) {
  return parseProxyEntry(`http://127.0.0.1:${String(port)}`);
}

/** A TLS layer that never gets as far as a real handshake. */
function tlsThatFails(code: string): typeof tls.connect {
  return ((_options: unknown, _onSecure?: () => void) => {
    const socket = new EventEmitter() as unknown as tls.TLSSocket;
    (socket as unknown as { destroy: () => void }).destroy = () => undefined;
    queueMicrotask(() => socket.emit('error', Object.assign(new Error(code), { code })));
    return socket;
  }) as unknown as typeof tls.connect;
}

/** A TLS layer that hands back whatever the canary is meant to have said. */
function tlsThatReplies(response: string): typeof tls.connect {
  return ((_options: unknown, onSecure?: () => void) => {
    const socket = new EventEmitter() as unknown as tls.TLSSocket;
    Object.assign(socket, {
      destroy: () => undefined,
      write: () => {
        queueMicrotask(() => socket.emit('data', Buffer.from(response, 'latin1')));
        return true;
      },
    });
    queueMicrotask(() => onSecure?.());
    return socket;
  }) as unknown as typeof tls.connect;
}

const OK_204 = 'HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n';

describe('HttpCanaryProxyProbe', () => {
  it('rejects a host that will not accept a connection, and says so', async () => {
    // Bind then close, so the port is real but nothing is behind it.
    const port = await listen(() => undefined);
    await new Promise<void>((resolve) => servers.pop()?.close(() => resolve()));

    const result = await new HttpCanaryProxyProbe({ timeoutMs: 500 }).probe(target(port));

    expect(result.ok).toBe(false);
    expect(result.stage).toBe('connect');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('rejects a host that accepts a connection but never answers the CONNECT', async () => {
    // The case a TCP probe cannot see at all: the handshake succeeds and the
    // proxy simply never forwards. Admitting this is how a pool fills with
    // entries that time out on their first real job.
    const port = await listen(() => undefined);

    const result = await new HttpCanaryProxyProbe({
      connectTimeoutMs: 200,
      timeoutMs: 400,
    }).probe(target(port));

    expect(result.ok).toBe(false);
    expect(result.stage).toBe('tunnel');
    expect(result.reason).toContain('timed out');
  });

  it.each([400, 403, 405, 407, 500])(
    'rejects a host that answers CONNECT with %i, and names the status',
    async (status) => {
      const port = await listen((socket) => {
        socket.write(`HTTP/1.1 ${String(status)} Nope\r\nContent-Length: 0\r\n\r\n`);
      });

      const result = await new HttpCanaryProxyProbe({ timeoutMs: 1_000 }).probe(target(port));

      expect(result.ok).toBe(false);
      expect(result.stage).toBe('tunnel');
      expect(result.reason).toBe(`CONNECT ${String(status)}`);
    },
  );

  it('rejects a reply that is not HTTP at all', async () => {
    const port = await listen((socket) => socket.write('\x05\x00\x00\x01 not http\r\n\r\n'));

    const result = await new HttpCanaryProxyProbe({ timeoutMs: 1_000 }).probe(target(port));

    expect(result.ok).toBe(false);
    expect(result.stage).toBe('tunnel');
    expect(result.reason).toBe('CONNECT reply was not HTTP');
  });

  it('rejects a proxy that intercepts TLS with its own certificate', async () => {
    // The proxy tunnels correctly and still must not be used: presenting its
    // own certificate means it is reading and can rewrite everything we send.
    const port = await listen((socket) => socket.write('HTTP/1.1 200 OK\r\n\r\n'));

    const result = await new HttpCanaryProxyProbe({
      timeoutMs: 1_000,
      tlsConnect: tlsThatFails('SELF_SIGNED_CERT_IN_CHAIN'),
    }).probe(target(port));

    expect(result.ok).toBe(false);
    expect(result.stage).toBe('tls');
    expect(result.reason).toBe('SELF_SIGNED_CERT_IN_CHAIN');
  });

  it('rejects a tunnel that does not return the canary status', async () => {
    const port = await listen((socket) => socket.write('HTTP/1.1 200 OK\r\n\r\n'));

    const result = await new HttpCanaryProxyProbe({
      timeoutMs: 1_000,
      tlsConnect: tlsThatReplies('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'),
    }).probe(target(port));

    expect(result.ok).toBe(false);
    expect(result.stage).toBe('response');
    expect(result.reason).toBe('canary HTTP 403');
  });

  it('admits a proxy that tunnels, handshakes and returns the canary unchanged', async () => {
    const port = await listen((socket) => socket.write('HTTP/1.1 200 OK\r\n\r\n'));

    const result = await new HttpCanaryProxyProbe({
      timeoutMs: 1_000,
      tlsConnect: tlsThatReplies(OK_204),
    }).probe(target(port));

    expect(result).toMatchObject({ ok: true, reason: null, stage: null });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('gives up immediately on a signal that is already aborted', async () => {
    const port = await listen((socket) => socket.write('HTTP/1.1 200 OK\r\n\r\n'));

    const result = await new HttpCanaryProxyProbe({ timeoutMs: 1_000 }).probe(
      target(port),
      AbortSignal.abort(),
    );

    expect(result).toMatchObject({ ok: false, reason: 'aborted' });
  });

  it('gives up when the signal aborts mid-probe', async () => {
    const port = await listen(() => undefined);
    const aborter = new AbortController();
    setTimeout(() => aborter.abort(), 20);

    const result = await new HttpCanaryProxyProbe({ timeoutMs: 5_000 }).probe(
      target(port),
      aborter.signal,
    );

    expect(result).toMatchObject({ ok: false, reason: 'aborted' });
  });

  it('never spends longer than its total budget, whatever the connect budget says', async () => {
    // A connect budget above the total is a misconfiguration, not a licence to
    // hang: the whole-probe deadline still has to bite.
    const port = await listen(() => undefined);
    const startedAt = Date.now();

    const result = await new HttpCanaryProxyProbe({
      connectTimeoutMs: 30_000,
      timeoutMs: 300,
    }).probe(target(port));

    expect(result.ok).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it('keeps proxy credentials out of the reason it reports', async () => {
    // Reasons travel into logs and run summaries, so the redaction that covers
    // every other proxy string has to cover this one too.
    const port = await listen((socket) => socket.write('HTTP/1.1 200 OK\r\n\r\n'));
    const authed = parseProxyEntry(`http://user:hunter2@127.0.0.1:${String(port)}`);

    const result = await new HttpCanaryProxyProbe({
      timeoutMs: 1_000,
      tlsConnect: tlsThatFails(`self-signed certificate from ${authed.url}`),
    }).probe(authed);

    expect(result.reason).not.toContain('hunter2');
  });

  it('refuses a canary that is not https, rather than probing something useless', () => {
    expect(() => new HttpCanaryProxyProbe({ canaryUrl: 'http://example.com/x' })).toThrow(/https/);
  });
});

/**
 * The one case the seams above cannot cover.
 *
 * Certificate validation against the public trust store is the whole point of
 * the `tls` stage, and an injected fake cannot exercise it: there is no way to
 * make a local server present a certificate the real trust store accepts. So
 * this runs opt-in against a proxy the operator supplies, and exists to catch
 * the seam drifting away from `tls.connect` unnoticed.
 *
 *   PROXY_PROBE_LIVE=http://host:port pnpm test http-canary
 */
describe.skipIf(process.env.PROXY_PROBE_LIVE === undefined)('live canary', () => {
  it('admits a working proxy and reports a real duration', async () => {
    const result = await new HttpCanaryProxyProbe({ timeoutMs: 8_000 }).probe(
      parseProxyEntry(process.env.PROXY_PROBE_LIVE as string),
    );

    expect(result.stage === null || result.stage === 'connect').toBe(true);
    expect(result.durationMs).toBeGreaterThan(0);
  });
});
