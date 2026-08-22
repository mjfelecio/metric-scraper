import {
  CAPACITY_PRESETS,
  DEFAULT_CAPACITY_INPUTS,
  FLAT_STAGES,
  TAPERED_STAGES,
  simulateCapacity,
  type CapacityInputs,
  type CapacitySimulationResult,
  type PollingStage,
} from '../../core/capacity/index.js';

export type LifecyclePreset = 'tapered' | 'flat' | 'custom';

export interface CapacityState {
  readonly inputs: CapacityInputs;
  readonly result: CapacitySimulationResult;
  readonly platformPreset: string;
  readonly lifecyclePreset: LifecyclePreset;
}

export type CapacityListener = (state: CapacityState) => void;

export function cloneCapacityInputs(inputs: CapacityInputs): CapacityInputs {
  return {
    ...inputs,
    stages: inputs.stages.map((stage) => ({ ...stage })),
    reliability: {
      ...inputs.reliability,
      retryBackoff: { ...inputs.reliability.retryBackoff },
    },
    capacity: {
      ...inputs.capacity,
      proxyLimits: { ...inputs.capacity.proxyLimits },
    },
    pricing: { ...inputs.pricing },
    growth: { ...inputs.growth },
  };
}

export function customCapacityInputs(): CapacityInputs {
  const base = cloneCapacityInputs(DEFAULT_CAPACITY_INPUTS);
  return {
    ...base,
    platform: 'custom',
    requestsPerJob: null,
    bytesPerHttpRequest: null,
    meanJobLatencyMs: null,
    p95JobLatencyMs: null,
    meanHttpLatencyMs: null,
    p95HttpLatencyMs: null,
    capacity: {
      ...base.capacity,
      httpRpmPerHost: null,
      proxyLimits: {
        ...base.capacity.proxyLimits,
        maxConcurrentPerProxy: null,
        maxRequestsPerMinutePerProxy: null,
        maxBytesPerMonthPerProxy: null,
        earnedConcurrencyPerProxy: null,
      },
    },
  };
}

export class CapacityStore {
  private state: CapacityState;
  private readonly listeners = new Set<CapacityListener>();

  constructor(inputs: CapacityInputs = DEFAULT_CAPACITY_INPUTS) {
    const cloned = cloneCapacityInputs(inputs);
    this.state = {
      inputs: cloned,
      result: simulateCapacity(cloned),
      platformPreset: cloned.platform,
      lifecyclePreset: lifecyclePresetFor(cloned.stages),
    };
  }

  getState(): CapacityState {
    return this.state;
  }

  subscribe(listener: CapacityListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  replaceInputs(
    inputs: CapacityInputs,
    labels: Partial<Pick<CapacityState, 'platformPreset' | 'lifecyclePreset'>> = {},
  ): void {
    const cloned = cloneCapacityInputs(inputs);
    this.publish({
      inputs: cloned,
      result: simulateCapacity(cloned),
      platformPreset: labels.platformPreset ?? this.state.platformPreset,
      lifecyclePreset: labels.lifecyclePreset ?? this.state.lifecyclePreset,
    });
  }

  update(project: (inputs: CapacityInputs) => CapacityInputs): void {
    const inputs = project(cloneCapacityInputs(this.state.inputs));
    this.publish({
      ...this.state,
      inputs,
      result: simulateCapacity(inputs),
      lifecyclePreset: lifecyclePresetFor(inputs.stages),
    });
  }

  applyPlatformPreset(id: string): void {
    if (id === 'custom') {
      this.replaceInputs(customCapacityInputs(), {
        platformPreset: 'custom',
        lifecyclePreset: 'tapered',
      });
      return;
    }
    const preset = CAPACITY_PRESETS.find((candidate) => candidate.id === id);
    if (preset !== undefined) {
      this.replaceInputs(preset.inputs, {
        platformPreset: id,
        lifecyclePreset: lifecyclePresetFor(preset.inputs.stages),
      });
    }
  }

  applyLifecyclePreset(id: LifecyclePreset): void {
    if (id === 'custom') return;
    const stages = id === 'tapered' ? TAPERED_STAGES : FLAT_STAGES;
    const inputs = { ...this.state.inputs, stages: stages.map((stage) => ({ ...stage })) };
    this.publish({
      ...this.state,
      inputs,
      result: simulateCapacity(inputs),
      lifecyclePreset: id,
    });
  }

  addStage(): void {
    const index = this.state.inputs.stages.length + 1;
    const id = nextStageId(this.state.inputs.stages);
    this.update((inputs) => ({
      ...inputs,
      stages: [
        ...inputs.stages,
        {
          id,
          label: `Stage ${String(index)}`,
          durationDays: 1,
          intervalMs: null,
          enabled: true,
        },
      ],
    }));
  }

  removeStage(index: number): void {
    this.update((inputs) => ({
      ...inputs,
      stages: inputs.stages.filter((_, candidate) => candidate !== index),
    }));
  }

  moveStage(index: number, offset: -1 | 1): void {
    const target = index + offset;
    if (target < 0 || target >= this.state.inputs.stages.length) return;
    this.update((inputs) => {
      const stages = [...inputs.stages];
      const current = stages[index];
      const other = stages[target];
      if (current === undefined || other === undefined) return inputs;
      stages[index] = other;
      stages[target] = current;
      return { ...inputs, stages };
    });
  }

  updateStage(index: number, patch: Partial<PollingStage>): void {
    this.update((inputs) => ({
      ...inputs,
      stages: inputs.stages.map((stage, candidate) =>
        candidate === index ? { ...stage, ...patch } : stage,
      ),
    }));
  }

  private publish(state: CapacityState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

function nextStageId(stages: readonly PollingStage[]): string {
  let suffix = 1;
  while (stages.some((stage) => stage.id === `stage-${String(suffix)}`)) suffix += 1;
  return `stage-${String(suffix)}`;
}

function lifecyclePresetFor(stages: readonly PollingStage[]): LifecyclePreset {
  if (sameStages(stages, TAPERED_STAGES)) return 'tapered';
  if (sameStages(stages, FLAT_STAGES)) return 'flat';
  return 'custom';
}

function sameStages(left: readonly PollingStage[], right: readonly PollingStage[]): boolean {
  return (
    left.length === right.length &&
    left.every((stage, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        stage.label === other.label &&
        stage.durationDays === other.durationDays &&
        stage.intervalMs === other.intervalMs &&
        stage.enabled === other.enabled
      );
    })
  );
}
