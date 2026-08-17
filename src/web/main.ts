import { type StartRunRequest } from '../app/types.js';
import { type InputFormat } from '../core/models/input.js';
import { type Platform } from '../core/models/platform.js';

import { ApiError, cancelRun, fetchDefaults, fetchRun, outputUrl, startRun } from './api.js';
import { render } from './render.js';
import { Store } from './state.js';
import './styles.css';

const POLL_INTERVAL_MS = 400;

const store = new Store();
store.subscribe(render);

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing element #${id}`);
  return node as T;
}

const platformSelect = byId<HTMLSelectElement>('platform');
const inputTextArea = byId<HTMLTextAreaElement>('input-text');
const fileInput = byId<HTMLInputElement>('input-file');
const concurrencyInput = byId<HTMLInputElement>('concurrency');
const targetRpmInput = byId<HTMLInputElement>('target-rpm');
const form = byId<HTMLFormElement>('run-form');
const cancelButton = byId<HTMLButtonElement>('cancel-button');
const downloadButton = byId<HTMLButtonElement>('download-button');

// --- configuration defaults -------------------------------------------------

async function loadDefaults(): Promise<void> {
  try {
    const defaults = await fetchDefaults();
    store.update({
      defaults,
      concurrency: defaults.concurrency,
      targetRpm: defaults.targetRpm,
    });
    concurrencyInput.value = String(defaults.concurrency);
    targetRpmInput.value = String(defaults.targetRpm);
  } catch (error) {
    store.update({
      status: 'failed',
      error: {
        code: error instanceof ApiError ? error.code : 'unexpected_error',
        message:
          error instanceof Error
            ? `could not load configuration — ${error.message}`
            : 'could not load configuration',
      },
    });
  }
}

// --- input handling ---------------------------------------------------------

for (const button of document.querySelectorAll<HTMLButtonElement>('.input-method-btn')) {
  button.addEventListener('click', () => {
    const method = button.dataset['method'];
    if (method === 'paste' || method === 'file') {
      store.update({ inputMethod: method });
    }
  });
}

inputTextArea.addEventListener('input', () => {
  store.update({ inputText: inputTextArea.value, format: 'auto', fileName: null });
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file === undefined) {
    store.update({ fileName: null, inputText: '', format: 'auto' });
    return;
  }

  const reader = new FileReader();
  reader.addEventListener('load', () => {
    const contents = typeof reader.result === 'string' ? reader.result : '';
    const format: InputFormat | 'auto' = file.name.toLowerCase().endsWith('.json')
      ? 'json'
      : file.name.toLowerCase().endsWith('.txt')
        ? 'text'
        : 'auto';
    store.update({ inputText: contents, fileName: file.name, format });
  });
  reader.addEventListener('error', () => {
    store.update({
      status: 'failed',
      error: { code: 'invalid_input', message: `could not read "${file.name}"` },
    });
  });
  reader.readAsText(file);
});

platformSelect.addEventListener('change', () => {
  const value = platformSelect.value;
  store.update({ platform: value === 'auto' ? 'auto' : (value as Platform) });
});

concurrencyInput.addEventListener('change', () => {
  store.update({ concurrency: clampInt(concurrencyInput.value, 1, 1_000, 10) });
});

targetRpmInput.addEventListener('change', () => {
  store.update({ targetRpm: clampInt(targetRpmInput.value, 0, 100_000, 500) });
});

// --- run lifecycle ----------------------------------------------------------

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void beginRun();
});

cancelButton.addEventListener('click', () => {
  const runId = store.getState().runId;
  if (runId === null) return;
  void cancelRun(runId).catch(() => {
    /* the poll loop will surface the resulting state */
  });
});

downloadButton.addEventListener('click', () => {
  const runId = store.getState().runId;
  if (runId === null) return;
  window.location.href = outputUrl(runId);
});

async function beginRun(): Promise<void> {
  const state = store.getState();

  if (state.inputText.trim().length === 0) {
    store.update({
      status: 'failed',
      error: {
        code: 'invalid_input',
        message: 'Provide at least one URL, either pasted or from a file.',
      },
    });
    return;
  }

  store.update({
    status: 'preparing',
    error: null,
    progress: null,
    summary: null,
    input: null,
    recentResults: [],
    hasOutput: false,
    runId: null,
  });

  const request: StartRunRequest = {
    platform: state.platform,
    input: state.inputText,
    format: state.format,
    concurrency: state.concurrency,
    targetRpm: state.targetRpm,
  };

  try {
    const started = await startRun(request);
    store.update({ runId: started.runId, status: started.state });
    void poll(started.runId);
  } catch (error) {
    store.update({
      status: 'failed',
      error: {
        code: error instanceof ApiError ? error.code : 'unexpected_error',
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

/**
 * Polls run state until it reaches a terminal state.
 *
 * Polling rather than streaming: a run is observed by one operator on a local
 * dev server, and this keeps the API surface small. Swapping in SSE later only
 * touches this function and the plugin.
 */
async function poll(runId: string): Promise<void> {
  for (;;) {
    try {
      const state = await fetchRun(runId);
      store.update({
        status: state.state,
        progress: state.progress,
        input: state.input,
        recentResults: state.recentResults,
        summary: state.summary,
        error: state.error,
        hasOutput: state.hasOutput,
      });

      if (state.state === 'completed' || state.state === 'failed') return;
    } catch (error) {
      store.update({
        status: 'failed',
        error: {
          code: error instanceof ApiError ? error.code : 'unexpected_error',
          message: error instanceof Error ? error.message : String(error),
        },
      });
      return;
    }

    await delay(POLL_INTERVAL_MS);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

void loadDefaults();
