import type { ResourceSamplingArtifacts } from './types.mts';

export interface StartResourceSamplingOptions {
  readonly skipGpuSampling: boolean;
  readonly outDir: string;
  readonly workspaceRoot: string;
  readonly observe: (message: string) => void;
}

export interface ResourceSamplingRun {
  readonly artifacts: ResourceSamplingArtifacts;
  stop(): Promise<void>;
}

export interface WindowsResourceScriptOptions {
  readonly csvPath: string;
  readonly summaryPath: string;
  readonly intervalMs: number;
}

export interface DxgiAdapter {
  readonly adapter_index: number;
  readonly luid: string;
  readonly description: string;
  readonly vendor_id: string;
  readonly device_id: string;
  readonly dedicated_video_memory_bytes: number;
  readonly dedicated_system_memory_bytes: number;
  readonly shared_system_memory_bytes: number;
  readonly adapter_kind: string;
}

export interface ResourceCsvRow {
  readonly timestamp: string;
  readonly source: string;
  readonly path: string;
  readonly pid: string;
  readonly name: string;
  readonly metric: string;
  readonly value: string;
  readonly unit: string;
}

export interface MutableAggregate {
  samples: number;
  sum: number;
  min: number | null;
  max: number | null;
}

export interface FinalAggregate {
  samples: number;
  min: number | null;
  max: number | null;
  avg: number | null;
}

export interface WindowsResourceSummary {
  sample_count: number;
  row_count: number;
  cpu: FinalAggregate;
  processes: Array<{
    name: string;
    pid: number;
    metrics: Record<string, FinalAggregate>;
  }>;
  gpu_adapters: Array<{
    luid: string;
    metrics: Record<string, FinalAggregate>;
    engine_types: Record<string, FinalAggregate>;
    process_memory_metrics: Record<string, FinalAggregate>;
  }>;
  target_process_gpu_usage: Array<{
    luid: string;
    pid: number;
    name: string | null;
    metrics: Record<string, FinalAggregate>;
  }>;
  errors: Record<string, number>;
}

export interface ResourceSamplerStopResult {
  readonly pid: number | null;
  readonly exit_code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly graceful: boolean;
  readonly forced: boolean;
  readonly stopped: boolean;
  readonly error: string | null;
}

export interface ResourceSamplerStopSummary {
  readonly started_at: string;
  readonly finished_at: string;
  readonly duration_ms: number;
  readonly child_count: number;
  readonly stopped_count: number;
  readonly forced_count: number;
  readonly error_count: number;
  readonly results: ResourceSamplerStopResult[];
}
