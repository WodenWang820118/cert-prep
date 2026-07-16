import type {
  DxgiAdapter,
  FinalAggregate,
  WindowsResourceSummary,
} from './resource-sampling-types.mts';
import { maxByPrefix } from './resource-sampling-csv.mts';

export function summarizeGpuByAdapter(
  windowsSummary: WindowsResourceSummary,
  dxgiAdapters: readonly DxgiAdapter[],
): object {
  const adaptersByLuid = new Map(dxgiAdapters.map((adapter) => [adapter.luid, adapter]));
  const utilizationByAdapter: Record<string, object> = {};
  const memoryByAdapter: Record<string, object> = {};

  for (const adapterSummary of windowsSummary.gpu_adapters) {
    const adapter = adaptersByLuid.get(adapterSummary.luid);
    const key = adapter?.adapter_kind ?? adapterSummary.luid;
    const engineTypes = adapterSummary.engine_types;
    utilizationByAdapter[key] = {
      luid: adapterSummary.luid,
      name: adapter?.description ?? null,
      adapter_kind: adapter?.adapter_kind ?? 'unmapped',
      max_engine_utilization_percent:
        adapterSummary.metrics.engine_utilization_percent?.max ?? null,
      avg_engine_utilization_percent:
        adapterSummary.metrics.engine_utilization_percent?.avg ?? null,
      max_compute_percent: maxByPrefix(engineTypes, 'compute'),
      max_3d_percent: engineTypes['3d']?.max ?? null,
      max_video_percent: Math.max(
        maxByPrefix(engineTypes, 'video') ?? 0,
        engineTypes.videodecode?.max ?? 0,
        engineTypes.videoencode?.max ?? 0,
      ),
    };
    memoryByAdapter[key] = {
      luid: adapterSummary.luid,
      name: adapter?.description ?? null,
      adapter_kind: adapter?.adapter_kind ?? 'unmapped',
      max_dedicated_usage_bytes:
        adapterSummary.metrics.dedicated_usage?.max ?? null,
      max_shared_usage_bytes: adapterSummary.metrics.shared_usage?.max ?? null,
      max_total_committed_bytes:
        adapterSummary.metrics.total_committed?.max ?? null,
      max_process_dedicated_usage_bytes:
        adapterSummary.process_memory_metrics.dedicated_usage?.max ?? null,
      max_process_shared_usage_bytes:
        adapterSummary.process_memory_metrics.shared_usage?.max ?? null,
    };
  }

  const processGpuUsage = windowsSummary.target_process_gpu_usage.map((usage) => {
    const adapter = adaptersByLuid.get(usage.luid);
    return {
      ...usage,
      adapter_kind: adapter?.adapter_kind ?? 'unmapped',
      adapter_name: adapter?.description ?? null,
    };
  });
  const namedProcessGpuUsage = processGpuUsage.filter(
    (usage) => usage.name !== null,
  );
  const processNames = new Set(
    windowsSummary.processes.map((process) => process.name.toLowerCase()),
  );
  const gpuRoutingChecks = gpuRoutingChecksForProcessUsage(
    dxgiAdapters,
    namedProcessGpuUsage,
    processNames,
  );

  return {
    gpu_utilization_by_adapter: utilizationByAdapter,
    gpu_memory_by_adapter: memoryByAdapter,
    target_process_gpu_usage: processGpuUsage,
    named_target_process_gpu_usage: namedProcessGpuUsage,
    gpu_routing_checks: gpuRoutingChecks,
  };
}

function gpuRoutingChecksForProcessUsage(
  dxgiAdapters: readonly DxgiAdapter[],
  processGpuUsage: Array<{
    luid: string;
    pid: number;
    name: string | null;
    metrics: Record<string, FinalAggregate>;
    adapter_kind: string;
    adapter_name: string | null;
  }>,
  processNames: ReadonlySet<string>,
): Record<string, boolean | number> {
  const windowsmlOcrUsage = processGpuUsage.filter(
    (usage) => usage.name === 'cert-prep-ocr-windowsml-runtime.exe',
  );
  const windowsmlOcrProcessObserved =
    processNames.has('cert-prep-ocr-windowsml-runtime.exe') ||
    windowsmlOcrUsage.length > 0;
  return {
    windowsml_ocr_process_observed: windowsmlOcrProcessObserved,
    ocr_uses_amd_igpu: hasAnyProcessGpuUsage(
      windowsmlOcrUsage.filter((usage) => usage.adapter_kind === 'amd_igpu'),
    ),
    gpu_luid_map_usable:
      hasRequiredAmdAdapter(dxgiAdapters) &&
      processGpuUsage.length > 0 &&
      processGpuUsage.every((usage) => usage.adapter_kind !== 'unmapped'),
  };
}

function hasRequiredAmdAdapter(dxgiAdapters: readonly DxgiAdapter[]): boolean {
  return dxgiAdapters.some((adapter) => adapter.adapter_kind === 'amd_igpu');
}

function hasAnyProcessGpuUsage(
  usages: Array<{ metrics: Record<string, FinalAggregate> }>,
): boolean {
  return usages.some((usage) => maxProcessGpuBytes([usage]) > 0);
}

function maxProcessGpuBytes(
  usages: Array<{ metrics: Record<string, FinalAggregate> }>,
): number {
  let max = 0;
  for (const usage of usages) {
    for (const metricName of [
      'dedicated_usage',
      'shared_usage',
      'total_committed',
    ]) {
      const value = usage.metrics[metricName]?.max;
      if (typeof value === 'number' && Number.isFinite(value)) {
        max = Math.max(max, value);
      }
    }
  }
  return max;
}
