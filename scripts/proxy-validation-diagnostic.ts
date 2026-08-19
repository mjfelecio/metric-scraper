/**
 * Measures what a proxy validation strategy actually buys.
 *
 * This is the tool that settled #26. The question it answers is not "how many
 * candidates pass" but "of the candidates a probe admits, how many can do the
 * work" — and those two numbers turned out to be wildly different: a TCP
 * connect admitted 42% of a live ProxyScrape list, of which 24% could complete
 * a single HTTPS request.
 *
 * It is a diagnostic, not part of the pipeline. Nothing in `src` imports it,
 * and it is here so the decision can be re-measured rather than re-argued: run
 * it again in six months and if the numbers have moved, the probe should move
 * with them.
 *
 *   pnpm diagnose:proxy
 *   pnpm diagnose:proxy --sample 400 --concurrency 40
 *   pnpm diagnose:proxy --targets          # see the warning below
 *
 * `--targets` additionally issues one real request per platform through every
 * admitted proxy. It is **off by default and must stay that way**: validation
 * generating platform traffic is exactly what #26 rules out. The flag exists
 * because answering "is proxy validity target-specific" needs the measurement
 * once, not because the pipeline should ever do this.
 */
import net from 'node:net';

import { ProxyAgent } from 'undici';

import { HttpCanaryProxyProbe } from '../src/infrastructure/proxy/http-canary-proxy-probe.js';
import { parseProxySourceText } from '../src/infrastructure/proxy/parse-proxy-source.js';
import { type ProxyTarget } from '../src/core/scraper/lease-ports.js';
import { type ProxyProbeStage } from '../src/core/scraper/proxy-source-ports.js';

const DEFAULT_SOURCE =
  'https://api.proxyscrape.com/v4/free-proxy-list/get' +
  '?request=display_proxies&proxy_format=protocolipport&format=text&protocol=http';

/** One request each, and only under `--targets`. */
const TARGETS = {
  tiktok: 'https://www.tiktok.com/embed/v2/7646786022889590024',
  instagram: 'https://www.instagram.com/',
} as const;

interface Options {
  sourceUrl: string;
  sample: number;
  concurrency: number;
  connectTimeoutMs: number;
  validateTimeoutMs: number;
  requestTimeoutMs: number;
  targets: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const value = (name: string, fallback: number): number => {
    const index = argv.indexOf(`--${name}`);
    if (index === -1) return fallback;
    const parsed = Number(argv[index + 1]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  const urlIndex = argv.indexOf('--source');
  return {
    sourceUrl: urlIndex === -1 ? DEFAULT_SOURCE : (argv[urlIndex + 1] ?? DEFAULT_SOURCE),
    sample: value('sample', 250),
    concurrency: value('concurrency', 30),
    // The production defaults. Changing these changes the answer — a probe
    // more patient than production certifies proxies production will reject.
    connectTimeoutMs: value('connect-timeout', 3_000),
    validateTimeoutMs: value('validate-timeout', 5_000),
    requestTimeoutMs: value('request-timeout', 15_000),
    targets: argv.includes('--targets'),
  };
}

/** The probe that is being replaced, kept here so the two can be compared. */
function tcpProbe(target: ProxyTarget, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: target.host, port: target.port });
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function forEachLimited<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        await run(items[index] as T);
      }
    }),
  );
}

/** Deterministic, so two runs of the diagnostic sample the same candidates. */
function sampleOf<T>(items: readonly T[], count: number): T[] {
  let seed = 42;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  return items
    .map((item) => [next(), item] as const)
    .sort((a, b) => a[0] - b[0])
    .map(([, item]) => item)
    .slice(0, count);
}

function percentiles(values: readonly number[]): string {
  if (values.length === 0) return 'n/a';
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
  return `p50 ${String(at(0.5))}ms, p95 ${String(at(0.95))}ms`;
}

function share(part: number, whole: number): string {
  return whole === 0 ? 'n/a' : `${((100 * part) / whole).toFixed(1)}%`;
}

async function reachTarget(target: ProxyTarget, url: string, timeoutMs: number): Promise<string> {
  const agent = new ProxyAgent({ uri: target.url, connectTimeout: 3_000 });
  try {
    const response = await fetch(url, {
      dispatcher: agent,
      signal: AbortSignal.timeout(timeoutMs),
    } as RequestInit);
    await response.text();
    return String(response.status);
  } catch (error) {
    let cursor: unknown = error;
    while (cursor instanceof Error) {
      const code = (cursor as NodeJS.ErrnoException).code;
      if (typeof code === 'string') return code;
      cursor = cursor.cause;
    }
    return error instanceof Error ? error.name : 'unknown';
  } finally {
    void agent.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const response = await fetch(options.sourceUrl, { headers: { accept: 'text/plain' } });
  if (!response.ok) throw new Error(`source returned HTTP ${String(response.status)}`);
  const list = parseProxySourceText(await response.text()).targets;
  const sample = sampleOf(list, options.sample);

  console.log(`source list: ${String(list.length)} candidates`);
  console.log(`sample: ${String(sample.length)}, concurrency ${String(options.concurrency)}`);
  console.log(
    `budget: connect ${String(options.connectTimeoutMs)}ms, probe ${String(options.validateTimeoutMs)}ms\n`,
  );

  const canary = new HttpCanaryProxyProbe({
    connectTimeoutMs: options.connectTimeoutMs,
    timeoutMs: options.validateTimeoutMs,
  });

  const stages: Record<ProxyProbeStage | 'admitted', number> = {
    connect: 0,
    tunnel: 0,
    tls: 0,
    response: 0,
    admitted: 0,
  };
  const admitted: ProxyTarget[] = [];
  const reasons = new Map<string, number>();
  const canaryLatency: number[] = [];
  let tcpPassed = 0;
  let tcpPassedAndUsable = 0;
  let tcpFailedButUsable = 0;

  await forEachLimited(sample, options.concurrency, async (target) => {
    // Both probes against the same candidate, which is the only way to say
    // what one predicts about the other.
    const tcpOk = await tcpProbe(target, options.validateTimeoutMs);
    const result = await canary.probe(target);

    if (tcpOk) tcpPassed += 1;
    if (result.ok) {
      stages.admitted += 1;
      admitted.push(target);
      canaryLatency.push(result.durationMs);
      if (tcpOk) tcpPassedAndUsable += 1;
      else tcpFailedButUsable += 1;
    } else if (result.stage !== null) {
      stages[result.stage] += 1;
      const key = `${result.stage}: ${result.reason ?? 'unknown'}`;
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
  });

  const n = sample.length;
  console.log('=== what each probe admits ===');
  console.log(`  TCP connect only : ${String(tcpPassed)} (${share(tcpPassed, n)})`);
  console.log(`  CONNECT+TLS+canary: ${String(stages.admitted)} (${share(stages.admitted, n)})`);
  console.log('');
  console.log('=== predictive value of the TCP probe ===');
  console.log(
    `  P(usable | TCP pass) = ${String(tcpPassedAndUsable)}/${String(tcpPassed)} = ${share(tcpPassedAndUsable, tcpPassed)}`,
  );
  console.log(
    `  admitted-but-unusable = ${String(tcpPassed - tcpPassedAndUsable)} (${share(tcpPassed - tcpPassedAndUsable, tcpPassed)} of admissions wasted)`,
  );
  // The other diagonal, reported because a filter that drops working proxies
  // is a different failure from one that admits broken ones. The two probes
  // run back to back rather than at once, so a small count here is churn in
  // the list itself, not the TCP probe being selective in a useful way.
  console.log(
    `  TCP-fail but usable   = ${String(tcpFailedButUsable)} of ${String(stages.admitted)} usable (${share(tcpFailedButUsable, stages.admitted)})`,
  );
  console.log('');
  console.log('=== where the canary probe stops ===');
  for (const stage of ['connect', 'tunnel', 'tls', 'response'] as const) {
    console.log(
      `  ${stage.padEnd(9)} ${String(stages[stage]).padStart(4)}  ${share(stages[stage], n)}`,
    );
  }
  console.log(`  admitted  ${String(stages.admitted).padStart(4)}  ${share(stages.admitted, n)}`);
  console.log('');
  console.log('=== most common rejections ===');
  for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${String(count).padStart(4)}  ${reason}`);
  }
  console.log('');
  console.log(`canary latency, admitted: ${percentiles(canaryLatency)}`);

  if (!options.targets) {
    console.log('\n(--targets not set: no request was made to any platform)');
    return;
  }

  console.log(`\n=== real target reachability of ${String(admitted.length)} admitted proxies ===`);
  console.log('(this issues platform traffic — investigation only, never the pipeline)');
  const hits: Record<keyof typeof TARGETS, number> = { tiktok: 0, instagram: 0 };
  let either = 0;
  await forEachLimited(admitted, 10, async (target) => {
    const results = {} as Record<keyof typeof TARGETS, string>;
    for (const [name, url] of Object.entries(TARGETS)) {
      results[name as keyof typeof TARGETS] = await reachTarget(
        target,
        url,
        options.requestTimeoutMs,
      );
    }
    let any = false;
    for (const name of Object.keys(TARGETS) as (keyof typeof TARGETS)[]) {
      if (results[name] === '200') {
        hits[name] += 1;
        any = true;
      }
    }
    if (any) either += 1;
    console.log(
      `  ${target.url.padEnd(28)} tiktok=${results.tiktok} instagram=${results.instagram}`,
    );
  });

  const total = admitted.length;
  console.log('');
  console.log(`  P(tiktok 200 | admitted)    = ${share(hits.tiktok, total)}`);
  console.log(`  P(instagram 200 | admitted) = ${share(hits.instagram, total)}`);
  console.log(`  P(either 200 | admitted)    = ${share(either, total)}`);
}

await main();
