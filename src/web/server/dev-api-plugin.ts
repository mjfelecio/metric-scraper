import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

import type { Plugin, ViteDevServer } from 'vite';

import type { RunService } from '../../app/run-service.js';
import type { StartRunRequest } from '../../app/types.js';
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

  const runMatch = /^\/runs\/([^/]+)(\/cancel|\/output)?$/.exec(route);
  if (runMatch !== null) {
    const runId = decodeURIComponent(runMatch[1] ?? '');
    const suffix = runMatch[2];

    if (method === 'GET' && suffix === undefined) {
      const state = service.get(runId);
      if (state === undefined) {
        sendJson(res, 404, { error: { code: 'not_found', message: `unknown run "${runId}"` } });
        return;
      }
      sendJson(res, 200, state);
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

  return { platform, input, format, concurrency, targetRpm };
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
