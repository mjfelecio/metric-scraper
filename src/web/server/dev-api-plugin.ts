import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

import type { Plugin, ViteDevServer } from 'vite';

import type { RunService } from '../../app/run-service.js';
import type { SessionScheduleDto, StartRunRequest } from '../../app/types.js';
import type { createLogger } from '../../infrastructure/logging/pino-logger.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const API_PREFIX = '/api';

/** Shapes of the backend modules loaded lazily through Vite's SSR loader. */
interface RunServiceModule {
  RunService: typeof RunService;
}
interface LoggerModule {
  createLogger: typeof createLogger;
}

/**
 * Exposes the application layer to the browser during `vite dev`.
 *
 * The dashboard is a development/observability tool, so it runs inside the
 * Vite dev server rather than behind a separate REST service — one process,
 * one command, and no duplicated wiring. If the UI ever needs to be deployed
 * on its own, this is the file that becomes a standalone HTTP server; nothing
 * below `src/app` changes.
 *
 * Modules are loaded through `ssrLoadModule` so the backend is transformed by
 * Vite on demand and stays out of the browser bundle.
 */
export function devApiPlugin(options: { projectRoot: string }): Plugin {
  let servicePromise: Promise<RunService> | null = null;

  const getService = async (server: ViteDevServer): Promise<RunService> => {
    servicePromise ??= (async (): Promise<RunService> => {
      const runServiceModule = (await server.ssrLoadModule(
        path.resolve(options.projectRoot, 'src/app/run-service.ts'),
      )) as unknown as RunServiceModule;
      const loggerModule = (await server.ssrLoadModule(
        path.resolve(options.projectRoot, 'src/infrastructure/logging/pino-logger.ts'),
      )) as unknown as LoggerModule;

      return new runServiceModule.RunService({
        logger: loggerModule.createLogger({ level: 'info', bindings: { source: 'web' } }),
      });
    })();
    return servicePromise;
  };

  return {
    name: 'metric-scraper:dev-api',
    apply: 'serve',
    configureServer(server) {
      // Mounted without a path prefix and matched explicitly: connect treats a
      // dot as a path boundary, so `use('/api', …)` would also swallow requests
      // for the browser module `/api.ts`.
      server.middlewares.use((req, res, next) => {
        if (!(req.url ?? '/').startsWith(`${API_PREFIX}/`)) {
          next();
          return;
        }
        handle(req, res, server, getService).catch((error: unknown) => {
          if (!res.headersSent) {
            sendJson(res, 500, {
              error: {
                code: 'unexpected_error',
                message: error instanceof Error ? error.message : String(error),
              },
            });
          } else {
            next(error);
          }
        });
      });
    },
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  server: ViteDevServer,
  getService: (server: ViteDevServer) => Promise<RunService>,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const route = url.pathname.slice(API_PREFIX.length).replace(/\/+$/, '') || '/';
  const method = req.method ?? 'GET';

  if (method === 'GET' && route === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const service = await getService(server);

  if (method === 'GET' && route === '/defaults') {
    sendJson(res, 200, service.defaults());
    return;
  }

  if (method === 'POST' && route === '/runs') {
    const body = await readJsonBody(req);
    const request = toStartRunRequest(body);
    if (request === null) {
      sendJson(res, 400, {
        error: { code: 'invalid_request', message: 'malformed start-run request body' },
      });
      return;
    }
    sendJson(res, 202, service.start(request));
    return;
  }

  if (method === 'GET' && route === '/runs') {
    sendJson(res, 200, service.list());
    return;
  }

  const runMatch = /^\/runs\/([^/]+)(\/cancel|\/output|\/session)?$/.exec(route);
  if (runMatch !== null) {
    const runId = decodeURIComponent(runMatch[1] ?? '');
    const suffix = runMatch[2];

    if (method === 'GET' && suffix === undefined) {
      // `?since=` is a timeline cursor. Without it a ten-minute session would
      // re-ship every sample it has on every 400ms poll.
      const sinceRaw = url.searchParams.get('since');
      const since = sinceRaw === null ? 0 : Number.parseInt(sinceRaw, 10);
      const state = service.get(runId, Number.isInteger(since) && since > 0 ? since : 0);
      if (state === undefined) {
        sendJson(res, 404, { error: { code: 'not_found', message: `unknown run "${runId}"` } });
        return;
      }
      sendJson(res, 200, state);
      return;
    }

    if (method === 'GET' && suffix === '/session') {
      const summary = service.sessionSummary(runId);
      if (summary === null) {
        sendJson(res, 404, {
          error: { code: 'not_found', message: `run "${runId}" has no session summary` },
        });
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('content-disposition', `attachment; filename="${runId}.session.json"`);
      res.end(JSON.stringify(summary, null, 2));
      return;
    }

    if (method === 'POST' && suffix === '/cancel') {
      sendJson(res, 200, { cancelled: service.cancel(runId) });
      return;
    }

    if (method === 'GET' && suffix === '/output') {
      try {
        const contents = await service.readOutput(runId);
        res.statusCode = 200;
        res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('content-disposition', `attachment; filename="${runId}.jsonl"`);
        res.end(contents);
      } catch (error) {
        sendJson(res, 404, {
          error: {
            code: 'output_unavailable',
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
      return;
    }
  }

  sendJson(res, 404, {
    error: { code: 'not_found', message: `no API route for ${method} ${route}` },
  });
}

function toStartRunRequest(body: unknown): StartRunRequest | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as Record<string, unknown>;

  const platform = raw['platform'];
  const input = raw['input'];
  const format = raw['format'];

  if (platform !== 'tiktok' && platform !== 'instagram' && platform !== 'auto') return null;
  if (typeof input !== 'string') return null;
  if (format !== 'auto' && format !== 'text' && format !== 'json') return null;

  const concurrency = Number(raw['concurrency']);
  const targetRpm = Number(raw['targetRpm']);
  if (!Number.isInteger(concurrency) || concurrency < 1) return null;
  if (!Number.isInteger(targetRpm) || targetRpm < 0) return null;

  const base: StartRunRequest = { platform, input, format, concurrency, targetRpm };

  if (raw['continuous'] !== true) return base;

  const schedule = toSchedule(raw['schedule']);
  if (schedule === null) return null;

  return { ...base, continuous: true, schedule };
}

/** Hand-rolled like the rest of this file; the dev API has no schema layer. */
function toSchedule(value: unknown): SessionScheduleDto | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;

  const intervalMs = Number(raw['intervalMs']);
  if (!Number.isInteger(intervalMs) || intervalMs < 0) return null;

  // `null` is meaningful here — it is how the UI says "no limit" — so an absent
  // key and an explicit null must both survive as null rather than becoming 0.
  const optional = (key: string, min: number): number | null | undefined => {
    const entry = raw[key];
    if (entry === null || entry === undefined) return null;
    const parsed = Number(entry);
    return Number.isInteger(parsed) && parsed >= min ? parsed : undefined;
  };

  const durationMs = optional('durationMs', 1);
  const maxCycles = optional('maxCycles', 1);
  if (durationMs === undefined || maxCycles === undefined) return null;

  return { intervalMs, durationMs, maxCycles };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}
