import net from 'node:net';

import { type ProxyTarget } from '../../core/scraper/lease-ports.js';
import { type ProxyProbe, type ProxyProbeResult } from '../../core/scraper/proxy-source-ports.js';

export interface TcpProxyProbeOptions {
  timeoutMs?: number | undefined;
  now?: (() => number) | undefined;
}

/**
 * Transport-level reachability check for a candidate proxy.
 *
 * A TCP handshake is all this asks for, and that is the point. On a free proxy
 * list the overwhelming majority of entries fail right here — a measured 16 of
 * 19 on one real list — so this removes most of the dead weight for the cost of
 * one connect, generating no traffic towards TikTok or Instagram at all.
 *
 * What it deliberately does *not* answer is whether a proxy is any good for our
 * targets. A host can accept connections and still refuse to forward, be
 * blocked by the platform, or be unusably slow. That question is settled by the
 * pool's probation tier on real jobs, which costs nothing extra because those
 * jobs were going to run anyway.
 */
export class TcpProxyProbe implements ProxyProbe {
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(options: TcpProxyProbeOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.now = options.now ?? (() => Date.now());
  }

  probe(target: ProxyTarget, signal?: AbortSignal): Promise<ProxyProbeResult> {
    const startedAt = this.now();

    return new Promise<ProxyProbeResult>((resolve) => {
      const socket = net.connect({ host: target.host, port: target.port });
      let settled = false;

      const finish = (ok: boolean, reason: string | null): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        socket.destroy();
        resolve({ ok, durationMs: this.now() - startedAt, reason });
      };

      const onAbort = (): void => finish(false, 'aborted');

      socket.setTimeout(this.timeoutMs);
      socket.once('connect', () => finish(true, null));
      socket.once('timeout', () => finish(false, 'connect timed out'));
      // The host is the whole identity here, so the code is the entire
      // diagnosis — no message to redact, and nothing to truncate.
      socket.once('error', (error: NodeJS.ErrnoException) =>
        finish(false, error.code ?? error.message),
      );

      if (signal?.aborted === true) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
