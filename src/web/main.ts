import { type SessionScheduleDto, type StartRunRequest } from '../app/types.js';
import { type InputFormat } from '../core/models/input.js';
import { type Platform } from '../core/models/platform.js';
import { formatDuration, parseDuration } from '../core/schedule/duration.js';

import {
  ApiError,
  cancelRun,
  fetchDefaults,
  fetchRun,
  outputUrl,
  sessionSummaryUrl,
  startRun,
} from './api.js';
import { render } from './render.js';
import { Store } from './state.js';
import './styles.css';

const POLL_INTERVAL_MS = 400;
/**
 * Polling slows right down between cycles. Hammering the API every 400ms
 * through a fifteen-minute gap buys nothing.
 */
const WAITING_POLL_INTERVAL_MS = 2_000;
/** Matches the server's retention, so the client cannot outgrow it either. */
const MAX_TIMELINE_SAMPLES = 2_000;

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
const sessionButton = byId<HTMLButtonElement>('session-button');
const continuousInput = byId<HTMLInputElement>('continuous');
const intervalInput = byId<HTMLInputElement>('interval');
const durationInput = byId<HTMLInputElement>('duration');
const maxCyclesInput = byId<HTMLInputElement>('max-cycles');

// --- configuration defaults -------------------------------------------------

async function loadDefaults(): Promise<void> {
  try {
    const defaults = await fetchDefaults();
    const interval = formatDuration(defaults.pollIntervalMs);
    store.update({
      defaults,
      concurrency: defaults.concurrency,
      targetRpm: defaults.targetRpm,
      interval,
    });
    concurrencyInput.value = String(defaults.concurrency);
    targetRpmInput.value = String(defaults.targetRpm);
    intervalInput.value = interval;
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

continuousInput.addEventListener('change', () => {
  store.update({ continuous: continuousInput.checked });
});

intervalInput.addEventListener('change', () => {
  store.update({ interval: intervalInput.value });
});

durationInput.addEventListener('change', () => {
  store.update({ duration: durationInput.value });
});

maxCyclesInput.addEventListener('change', () => {
  store.update({ maxCycles: maxCyclesInput.value });
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

sessionButton.addEventListener('click', () => {
  const runId = store.getState().runId;
  if (runId === null) return;
  window.location.href = sessionSummaryUrl(runId);
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

  let schedule: SessionScheduleDto | null = null;
  if (state.continuous) {
    try {
      schedule = buildSchedule(state.interval, state.duration, state.maxCycles);
    } catch (error) {
      store.update({
        status: 'failed',
        error: {
          code: 'invalid_input',
          message: error instanceof Error ? error.message : String(error),
        },
      });
      return;
    }
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
    schedule,
    cycle: null,
    timeline: [],
    timelineCursor: 0,
    cycles: [],
    sessionSummary: null,
    stalled: false,
  });

  const request: StartRunRequest = {
    platform: state.platform,
    input: state.inputText,
    format: state.format,
    concurrency: state.concurrency,
    targetRpm: state.targetRpm,
    ...(schedule === null ? {} : { continuous: true, schedule }),
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
    let waiting = false;
    try {
      // Ask only for samples we have not already seen: over a ten-minute
      // session the timeline dwarfs everything else in the payload.
      const cursor = store.getState().timelineCursor;
      const state = await fetchRun(runId, cursor);
      waiting = state.state === 'waiting';

      const previous = store.getState();
      store.update({
        status: state.state,
        progress: state.progress,
        input: state.input,
        recentResults: state.recentResults,
        summary: state.summary,
        error: state.error,
        hasOutput: state.hasOutput,
        proxies: state.proxies,
        continuous: state.continuous,
        schedule: state.schedule,
        cycle: state.cycle,
        cycles: state.cycles,
        sessionSummary: state.sessionSummary,
        stalled: state.stalled,
        timeline:
          state.timeline.length === 0
            ? previous.timeline
            : [...previous.timeline, ...state.timeline].slice(-MAX_TIMELINE_SAMPLES),
        timelineCursor: state.timelineCursor,
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

    await delay(waiting ? WAITING_POLL_INTERVAL_MS : POLL_INTERVAL_MS);
  }
}

/**
 * Turns the three schedule fields into a request, rejecting nonsense before it
 * reaches the API so the operator sees a useful message rather than a 400.
 */
function buildSchedule(interval: string, duration: string, maxCycles: string): SessionScheduleDto {
  const intervalMs = parseDuration(interval.trim().length === 0 ? '0' : interval);

  const durationMs = duration.trim().length === 0 ? null : parseDuration(duration);
  if (durationMs !== null && durationMs <= 0) {
    throw new Error('Duration must be greater than zero, or blank for no limit.');
  }

  const cycles = maxCycles.trim().length === 0 ? null : Number.parseInt(maxCycles, 10);
  if (cycles !== null && (!Number.isInteger(cycles) || cycles < 1)) {
    throw new Error('Max cycles must be a whole number of at least 1, or blank for no limit.');
  }

  return { intervalMs, durationMs, maxCycles: cycles };
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
