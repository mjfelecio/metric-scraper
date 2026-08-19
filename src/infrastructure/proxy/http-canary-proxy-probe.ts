import net from 'node:net';
import tls from 'node:tls';

import { type ProxyTarget } from '../../core/scraper/lease-ports.js';
import {
  type ProxyProbe,
  type ProxyProbeResult,
  type ProxyProbeStage,
} from '../../core/scraper/proxy-source-ports.js';

import { redactEntry } from './proxy-config.js';

/**
 * A neutral origin, chosen for being boring.
 *
 * It has to be somewhere we have no relationship with, that answers from
 * everywhere a free proxy might exit, and that returns as close to nothing as
 * HTTP allows — 204, no body, no redirect, no cookie. `generate_204` exists
 * precisely to be fetched by software checking whether a network works, so
 * probing it is the traffic it was built for. Crucially it is *not* TikTok or
 * Instagram: validation that touched a platform would spend the platform's
 * tolerance for us on candidates that mostly turn out to be junk.
 */
const DEFAULT_CANARY_URL = 'https://www.gstatic.com/generate_204';
const DEFAULT_EXPECT_STATUS = 204;

/** Reasons are for reading, not parsing. */
const MAX_REASON_LENGTH = 120;
/** A CONNECT reply or a response head past this is not one we want to parse. */
const MAX_HEAD_BYTES = 16_384;

export interface HttpCanaryProxyProbeOptions {
  /** Absolute `https:` URL. Must not be a platform we scrape. */
  canaryUrl?: string | undefined;
  /** The status that proves the response came back unmodified. */
  expectStatus?: number | undefined;
  /**
   * Budget for reaching the proxy itself.
   *
   * Must match `PROXY_CONNECT_TIMEOUT_MS`, and `createProxySupply` passes
   * exactly that. A probe more patient than production is worse than no probe:
   * it certifies slow proxies that undici then drops on its own connect
   * timeout, so the admission looks sound and every job through it fails.
   * Measured — raising this probe's budget from 5s to 8s admitted 8 more
   * proxies out of 120 and *lowered* the share that reached a real target.
   */
  connectTimeoutMs?: number | undefined;
  /** Budget for the whole probe, connect included. */
  timeoutMs?: number | undefined;
  now?: (() => number) | undefined;
  /** Seams for tests. Production uses the node built-ins. */
  connect?: typeof net.connect;
  tlsConnect?: typeof tls.connect;
}

/**
 * Establishes that a candidate proxy can carry an HTTPS request, end to end.
 *
 * Four things happen, in the order the scrapers will need them, and the probe
 * reports which one failed:
 *
 * 1. `connect` — a TCP connection to the proxy.
 * 2. `tunnel`  — `CONNECT canary:443`, answered `200`.
 * 3. `tls`     — a handshake with the canary, validated against the public
 *                trust store.
 * 4. `response`— the canary's own status code, unaltered.
 *
 * Stages 2 to 4 are the reason this class exists. Measured against a live
 * ProxyScrape list of 695 entries, 42% of candidates accept a TCP connection
 * but only 10% complete this sequence: the difference is hosts that are not
 * proxies at all (`CONNECT 400`), proxies that intercept TLS with their own
 * certificate, and proxies too slow to be usable. None of that is visible to a
 * connect probe, and all of it fails on the first real job instead.
 *
 * The trust store is deliberately *not* relaxed. A proxy presenting its own
 * certificate for the canary is a proxy reading and rewriting everything we
 * send through it, which is a reason to reject it, not a certificate problem to
 * work around.
 */
export class HttpCanaryProxyProbe implements ProxyProbe {
  private readonly canaryHost: string;
  private readonly canaryPort: number;
  private readonly canaryPath: string;
  private readonly expectStatus: number;
  private readonly connectTimeoutMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly connect: typeof net.connect;
  private readonly tlsConnect: typeof tls.connect;

  constructor(options: HttpCanaryProxyProbeOptions = {}) {
    const url = new URL(options.canaryUrl ?? DEFAULT_CANARY_URL);
    if (url.protocol !== 'https:') {
      throw new Error(`canary URL must be https, got ${url.protocol}`);
    }
    this.canaryHost = url.hostname;
    this.canaryPort = url.port === '' ? 443 : Number(url.port);
    this.canaryPath = `${url.pathname}${url.search}`;
    this.expectStatus = options.expectStatus ?? DEFAULT_EXPECT_STATUS;
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 5_000);
    // Clamped rather than validated: a connect budget above the total budget is
    // simply the total budget, and a probe is no place to throw on config.
    this.connectTimeoutMs = Math.min(
      Math.max(1, options.connectTimeoutMs ?? 3_000),
      this.timeoutMs,
    );
    this.now = options.now ?? (() => Date.now());
    this.connect = options.connect ?? net.connect;
    this.tlsConnect = options.tlsConnect ?? tls.connect;
  }

  probe(target: ProxyTarget, signal?: AbortSignal): Promise<ProxyProbeResult> {
    const startedAt = this.now();

    return new Promise<ProxyProbeResult>((resolve) => {
      let stage: ProxyProbeStage = 'connect';
      let settled = false;
      let socket: net.Socket | null = null;
      let secure: tls.TLSSocket | null = null;

      const timers: NodeJS.Timeout[] = [];
      const finish = (ok: boolean, reason: string | null): void => {
        if (settled) return;
        settled = true;
        for (const timer of timers) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        secure?.destroy();
        socket?.destroy();
        resolve({
          ok,
          durationMs: this.now() - startedAt,
          reason: reason === null ? null : shorten(redactEntry(reason)),
          stage: ok ? null : stage,
        });
      };
      const fail = (reason: string): void => finish(false, reason);
      const onAbort = (): void => fail('aborted');

      if (signal?.aborted === true) {
        finish(false, 'aborted');
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });

      timers.push(setTimeout(() => fail(`${stage} timed out`), this.timeoutMs));
      timers.push(
        setTimeout(() => {
          if (stage === 'connect') fail('connect timed out');
        }, this.connectTimeoutMs),
      );

      socket = this.connect({ host: target.host, port: target.port });
      // The proxy's own identity is the whole diagnosis at this stage, so the
      // error code is the entire message worth keeping.
      socket.on('error', (error: NodeJS.ErrnoException) => fail(error.code ?? error.message));

      socket.once('connect', () => {
        stage = 'tunnel';
        const authority = `${this.canaryHost}:${String(this.canaryPort)}`;
        socket?.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
      });

      let head = '';
      const onTunnelData = (chunk: Buffer): void => {
        head += chunk.toString('latin1');
        if (!head.includes('\r\n\r\n')) {
          if (head.length > MAX_HEAD_BYTES) fail('CONNECT reply too large');
          return;
        }
        socket?.off('data', onTunnelData);

        const status = statusOf(head);
        if (status !== 200) {
          // A web server answering 400/405 here is the single most common way a
          // free-list entry is not a proxy at all.
          fail(status === null ? 'CONNECT reply was not HTTP' : `CONNECT ${String(status)}`);
          return;
        }

        stage = 'tls';
        if (socket === null) return;
        secure = this.tlsConnect({ socket, servername: this.canaryHost }, () => {
          stage = 'response';
          let response = '';
          secure?.on('data', (part: Buffer) => {
            response += part.toString('latin1');
            if (!response.includes('\r\n\r\n')) {
              if (response.length > MAX_HEAD_BYTES) fail('canary response head too large');
              return;
            }
            const code = statusOf(response);
            if (code === this.expectStatus) finish(true, null);
            // A status of our own choosing coming back as something else means
            // the tunnel is not carrying the origin's response.
            else fail(code === null ? 'canary reply was not HTTP' : `canary HTTP ${String(code)}`);
          });
          secure?.write(
            `GET ${this.canaryPath} HTTP/1.1\r\n` +
              `Host: ${this.canaryHost}\r\n` +
              'Connection: close\r\n\r\n',
          );
        });
        secure.on('error', (error: NodeJS.ErrnoException) => fail(error.code ?? error.message));
      };

      socket.on('data', onTunnelData);
    });
  }
}

function statusOf(head: string): number | null {
  const match = /^HTTP\/1\.[01] (\d{3})/.exec(head);
  return match === null ? null : Number(match[1]);
}

function shorten(value: string): string {
  return value.length > MAX_REASON_LENGTH ? `${value.slice(0, MAX_REASON_LENGTH)}…` : value;
}
