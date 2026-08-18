import { type RunDefaultsDto, type RunStateDto, type StartRunRequest } from '../app/types.js';

/**
 * Thin client for the dev API exposed by the Vite plugin.
 *
 * This is the only place in the browser bundle that knows a network boundary
 * exists — everything else works against the DTOs. If the backend later moves
 * behind a real HTTP service, only this file changes.
 */

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(options: { code: string; message: string; status: number }) {
    super(options.message);
    this.name = 'ApiError';
    this.code = options.code;
    this.status = options.status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, init);
  } catch (error) {
    throw new ApiError({
      code: 'network_error',
      message: `cannot reach the dev API: ${error instanceof Error ? error.message : String(error)}`,
      status: 0,
    });
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError({
      code: error?.code ?? 'http_error',
      message: error?.message ?? `request failed with status ${response.status}`,
      status: response.status,
    });
  }

  return payload as T;
}

export function fetchDefaults(): Promise<RunDefaultsDto> {
  return request<RunDefaultsDto>('/defaults');
}

export function startRun(body: StartRunRequest): Promise<RunStateDto> {
  return request<RunStateDto>('/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** `since` is a timeline cursor: only samples newer than it come back. */
export function fetchRun(runId: string, since = 0): Promise<RunStateDto> {
  const query = since > 0 ? `?since=${String(since)}` : '';
  return request<RunStateDto>(`/runs/${encodeURIComponent(runId)}${query}`);
}

export function cancelRun(runId: string): Promise<{ cancelled: boolean }> {
  return request<{ cancelled: boolean }>(`/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
  });
}

export function outputUrl(runId: string): string {
  return `/api/runs/${encodeURIComponent(runId)}/output`;
}

export function sessionSummaryUrl(runId: string): string {
  return `/api/runs/${encodeURIComponent(runId)}/session`;
}
