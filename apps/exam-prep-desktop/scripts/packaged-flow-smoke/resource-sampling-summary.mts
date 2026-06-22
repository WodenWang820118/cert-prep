import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { errorMessage, normalizePath } from './text-utils.mts';
import type { ResourceSamplingArtifacts } from './types.mts';
import type {
  DxgiAdapter,
  FinalAggregate,
  MutableAggregate,
  NvidiaSmiRow,
  ResourceCsvRow,
  ResourceSamplerStopSummary,
  WindowsResourceSummary,
} from './resource-sampling-types.mts';

const NVIDIA_OCR_PROCESS_MEMORY_GATE_BYTES = 64 * 1024 * 1024;

export function finalizeResourceSamplingArtifacts({
  outDir,
  workspaceRoot,
  artifacts,
  observe,
  samplerStopSummary = null,
}: {
  readonly outDir: string;
  readonly workspaceRoot: string;
  readonly artifacts: ResourceSamplingArtifacts;
  readonly observe: (message: string) => void;
  readonly samplerStopSummary?: ResourceSamplerStopSummary | null;
}): void {
  const summaryPath = join(outDir, 'windows-resource-summary.json');
  const windowsCsvPath = join(outDir, 'windows-resource-sampling.csv');
  const nvidiaCsvPath = join(outDir, 'nvidia-smi.csv');
  const dxgiAdaptersPath = join(outDir, 'windows-dxgi-adapters.json');
  const initialSummary = readJsonFile(summaryPath);
  const windowsResourceSummary = existsSync(windowsCsvPath)
    ? summarizeWindowsResourceCsv(readFileSync(windowsCsvPath, 'utf8'))
    : null;
  const dxgiAdapters = readDxgiAdapters(dxgiAdaptersPath);
  const adapterAwareSummary =
    windowsResourceSummary === null
      ? null
      : summarizeGpuByAdapter(windowsResourceSummary, dxgiAdapters);
  const summary = {
    ...(isRecord(initialSummary) ? initialSummary : {}),
    finalized_at: new Date().toISOString(),
    adapter_mapping_note:
      'Windows GPU counters expose adapter LUIDs. DXGI adapter metadata maps those runtime LUIDs to AMD/Nvidia adapter names when available.',
    artifacts,
    sampler_stop: samplerStopSummary,
    dxgi_adapters: dxgiAdapters,
    gpu_luid_map_status: gpuLuidMapStatus(windowsResourceSummary, dxgiAdapters),
    unmapped_gpu_luids: unmappedGpuLuids(windowsResourceSummary, dxgiAdapters),
    windows_resource_summary: windowsResourceSummary,
    ...(adapterAwareSummary ?? {}),
    nvidia_smi_summary: existsSync(nvidiaCsvPath)
      ? summarizeNvidiaSmiCsv(readFileSync(nvidiaCsvPath, 'utf8'), {
          csvPath: normalizePath(relative(workspaceRoot, nvidiaCsvPath)),
        })
      : null,
  };
  try {
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  } catch (error) {
    observe(`resource summary finalize failed: ${errorMessage(error)}`);
  }
}

export function summarizeWindowsResourceCsv(csvText: string): WindowsResourceSummary {
  const rows = parseCsv(csvText).map(resourceCsvRow).filter(isResourceCsvRow);
  const timestamps = new Set(rows.map((row) => row.timestamp).filter(Boolean));
  const cpu = newAggregate();
  const processAggregates = new Map<string, Record<string, MutableAggregate>>();
  const adapterAggregates = new Map<string, Record<string, MutableAggregate>>();
  const adapterEngineTypes = new Map<string, Record<string, MutableAggregate>>();
  const adapterProcessMemory = new Map<string, Record<string, MutableAggregate>>();
  const processGpuUsage = new Map<string, Record<string, MutableAggregate>>();
  const processNamesByPid = new Map<string, string>();
  const errorCounts = new Map<string, number>();

  for (const row of rows) {
    const value = Number(row.value);
    if (!Number.isFinite(value)) {
      continue;
    }
    if (!isValidResourceCounterValue(row, value)) {
      continue;
    }

    if (row.source === 'windows_cpu' && row.metric === 'percent_processor_time') {
      addAggregate(cpu, value);
      continue;
    }

    if (row.source === 'windows_process') {
      const key = `${row.name}:${row.pid}`;
      processNamesByPid.set(row.pid, row.name);
      const aggregates = mapRecord(processAggregates, key);
      addAggregate(mapAggregate(aggregates, row.metric), value);
      continue;
    }

    if (row.source === 'windows_gpu_counter') {
      const luid = extractLuid(row.path);
      if (!luid) {
        continue;
      }
      const metricName = normalizedCounterMetric(row.path);
      if (/gpu adapter memory/i.test(row.path)) {
        addAggregate(
          mapAggregate(mapRecord(adapterAggregates, luid), metricName),
          value,
        );
      } else if (/gpu engine/i.test(row.path)) {
        addAggregate(
          mapAggregate(mapRecord(adapterAggregates, luid), 'engine_utilization_percent'),
          value,
        );
        addAggregate(
          mapAggregate(
            mapRecord(adapterEngineTypes, luid),
            extractEngineType(row.path) ?? 'unknown',
          ),
          value,
        );
      } else if (/gpu process memory/i.test(row.path)) {
        addAggregate(
          mapAggregate(mapRecord(adapterProcessMemory, luid), metricName),
          value,
        );
        const pid = extractPid(row.path);
        if (pid !== null) {
          addAggregate(
            mapAggregate(mapRecord(processGpuUsage, `${luid}:${pid}`), metricName),
            value,
          );
        }
      }
      continue;
    }

    if (row.source === 'error') {
      errorCounts.set(row.metric, (errorCounts.get(row.metric) ?? 0) + 1);
    }
  }

  return {
    sample_count: timestamps.size,
    row_count: rows.length,
    cpu: finalizeAggregate(cpu),
    processes: [...processAggregates.entries()].map(([key, metrics]) => {
      const [name, pid] = key.split(':');
      return {
        name,
        pid: Number(pid),
        metrics: finalizeAggregateRecord(metrics),
      };
    }),
    gpu_adapters: [...adapterAggregates.entries()].map(([luid, metrics]) => ({
      luid,
      metrics: finalizeAggregateRecord(metrics),
      engine_types: finalizeAggregateRecord(adapterEngineTypes.get(luid) ?? {}),
      process_memory_metrics: finalizeAggregateRecord(
        adapterProcessMemory.get(luid) ?? {},
      ),
    })),
    target_process_gpu_usage: [...processGpuUsage.entries()].map(
      ([key, metrics]) => {
        const [luid, pidText] = key.split(':');
        return {
          luid,
          pid: Number(pidText),
          name: processNamesByPid.get(pidText) ?? null,
          metrics: finalizeAggregateRecord(metrics),
        };
      },
    ),
    errors: Object.fromEntries(errorCounts.entries()),
  };
}

function isValidResourceCounterValue(row: ResourceCsvRow, value: number): boolean {
  if (
    row.source === 'windows_gpu_counter' &&
    /gpu engine/i.test(row.path) &&
    /utilization percentage/i.test(row.path)
  ) {
    return value >= 0 && value <= 100;
  }
  return true;
}

export function summarizeNvidiaSmiCsv(
  csvText: string,
  options: { readonly csvPath?: string } = {},
): object {
  const rows = parseCsv(csvText)
    .slice(1)
    .map(nvidiaSmiRow)
    .filter(isNvidiaSmiRow);
  const utilization = newAggregate();
  const memoryUsed = newAggregate();
  const memoryTotal = newAggregate();
  const powerDraw = newAggregate();
  for (const row of rows) {
    addOptionalAggregate(utilization, row.utilizationGpuPercent);
    addOptionalAggregate(memoryUsed, row.memoryUsedMiB);
    addOptionalAggregate(memoryTotal, row.memoryTotalMiB);
    addOptionalAggregate(powerDraw, row.powerDrawW);
  }
  return {
    ...(options.csvPath ? { csv_path: options.csvPath } : {}),
    sample_count: rows.length,
    gpu_utilization_percent: finalizeAggregate(utilization),
    memory_used_mib: finalizeAggregate(memoryUsed),
    memory_total_mib: finalizeAggregate(memoryTotal),
    power_draw_w: finalizeAggregate(powerDraw),
  };
}

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
  const gpuRoutingChecks = gpuRoutingChecksForProcessUsage(
    windowsSummary,
    dxgiAdapters,
    namedProcessGpuUsage,
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
  windowsSummary: WindowsResourceSummary,
  dxgiAdapters: readonly DxgiAdapter[],
  processGpuUsage: Array<{
    luid: string;
    pid: number;
    name: string | null;
    metrics: Record<string, FinalAggregate>;
    adapter_kind: string;
    adapter_name: string | null;
  }>,
): Record<string, boolean | number> {
  const directmlOcrUsage = processGpuUsage.filter(
    (usage) => usage.name === 'exam-prep-ocr-directml-runtime.exe',
  );
  const reasoningUsage = processGpuUsage.filter(
    (usage) => isReasoningProcessName(usage.name),
  );
  const ocrNvidiaMaxBytes = maxProcessGpuBytes(
    directmlOcrUsage.filter((usage) => usage.adapter_kind === 'nvidia_dgpu'),
  );
  return {
    directml_ocr_process_observed: directmlOcrUsage.length > 0,
    ocr_uses_amd_igpu: hasAnyProcessGpuUsage(
      directmlOcrUsage.filter((usage) => usage.adapter_kind === 'amd_igpu'),
    ),
    ocr_avoids_nvidia_dgpu:
      directmlOcrUsage.length > 0 &&
      ocrNvidiaMaxBytes <= NVIDIA_OCR_PROCESS_MEMORY_GATE_BYTES,
    ocr_nvidia_process_memory_max_bytes: ocrNvidiaMaxBytes,
    ocr_nvidia_process_memory_gate_bytes: NVIDIA_OCR_PROCESS_MEMORY_GATE_BYTES,
    reasoning_uses_nvidia_dgpu: hasAnyProcessGpuUsage(
      reasoningUsage.filter((usage) => usage.adapter_kind === 'nvidia_dgpu'),
    ),
    gpu_luid_map_usable:
      hasRequiredAdapterKinds(dxgiAdapters) &&
      processGpuUsage.length > 0 &&
      processGpuUsage.every((usage) => usage.adapter_kind !== 'unmapped'),
  };
}

function isReasoningProcessName(name: string | null): boolean {
  return (
    name === 'ollama.exe' ||
    name === 'ollama app.exe' ||
    name === 'llama-server.exe' ||
    name === 'ollama_llama_server.exe'
  );
}

function hasRequiredAdapterKinds(dxgiAdapters: readonly DxgiAdapter[]): boolean {
  const kinds = new Set(dxgiAdapters.map((adapter) => adapter.adapter_kind));
  return kinds.has('amd_igpu') && kinds.has('nvidia_dgpu');
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

function readJsonFile(path: string): unknown {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readUtfJsonFile(path)) as unknown;
  } catch {
    return null;
  }
}

function readUtfJsonFile(path: string): string {
  const bytes = readFileSync(path);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString('utf8');
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString('utf16le');
  }
  return bytes.toString('utf8').replace(/^\uFEFF/, '');
}

export function readDxgiAdapters(path: string): DxgiAdapter[] {
  const payload = readJsonFile(path);
  if (!isRecord(payload) || !Array.isArray(payload.adapters)) {
    return [];
  }
  return payload.adapters.filter(isDxgiAdapter).map((adapter) => ({
    ...adapter,
    luid: adapter.luid.toLowerCase(),
  }));
}

function isDxgiAdapter(value: unknown): value is DxgiAdapter {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.adapter_index === 'number' &&
    typeof value.luid === 'string' &&
    typeof value.description === 'string' &&
    typeof value.vendor_id === 'string' &&
    typeof value.device_id === 'string' &&
    typeof value.dedicated_video_memory_bytes === 'number' &&
    typeof value.dedicated_system_memory_bytes === 'number' &&
    typeof value.shared_system_memory_bytes === 'number' &&
    typeof value.adapter_kind === 'string'
  );
}

function gpuLuidMapStatus(
  windowsSummary: WindowsResourceSummary | null,
  dxgiAdapters: readonly DxgiAdapter[],
): 'complete' | 'partial' | 'unavailable' {
  if (!windowsSummary || dxgiAdapters.length === 0) {
    return 'unavailable';
  }
  return unmappedGpuLuids(windowsSummary, dxgiAdapters).length === 0
    ? 'complete'
    : 'partial';
}

function unmappedGpuLuids(
  windowsSummary: WindowsResourceSummary | null,
  dxgiAdapters: readonly DxgiAdapter[],
): string[] {
  if (!windowsSummary) {
    return [];
  }
  const mapped = new Set(dxgiAdapters.map((adapter) => adapter.luid));
  return windowsSummary.gpu_adapters
    .map((adapter) => adapter.luid)
    .filter((luid) => !mapped.has(luid));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCsv(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map(parseCsvLine);
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

function resourceCsvRow(row: string[]): ResourceCsvRow | null {
  if (row.length < 8 || row[0] === 'timestamp') {
    return null;
  }
  return {
    timestamp: row[0],
    source: row[1],
    path: row[2],
    pid: row[3],
    name: row[4],
    metric: row[5],
    value: row[6],
    unit: row[7],
  };
}

function isResourceCsvRow(row: ResourceCsvRow | null): row is ResourceCsvRow {
  return row !== null;
}

function nvidiaSmiRow(row: string[]): NvidiaSmiRow | null {
  if (row.length < 5) {
    return null;
  }
  return {
    utilizationGpuPercent: firstNumber(row[1]),
    memoryUsedMiB: firstNumber(row[2]),
    memoryTotalMiB: firstNumber(row[3]),
    powerDrawW: firstNumber(row[4]),
  };
}

function isNvidiaSmiRow(row: NvidiaSmiRow | null): row is NvidiaSmiRow {
  return row !== null;
}

function firstNumber(value: string): number | null {
  const match = /-?\d+(?:\.\d+)?/.exec(value);
  return match ? Number(match[0]) : null;
}

function newAggregate(): MutableAggregate {
  return {
    samples: 0,
    sum: 0,
    min: null,
    max: null,
  };
}

function addOptionalAggregate(
  aggregate: MutableAggregate,
  value: number | null,
): void {
  if (value !== null) {
    addAggregate(aggregate, value);
  }
}

function addAggregate(aggregate: MutableAggregate, value: number): void {
  aggregate.samples += 1;
  aggregate.sum += value;
  aggregate.min = aggregate.min === null ? value : Math.min(aggregate.min, value);
  aggregate.max = aggregate.max === null ? value : Math.max(aggregate.max, value);
}

function finalizeAggregate(aggregate: MutableAggregate): FinalAggregate {
  return {
    samples: aggregate.samples,
    min: aggregate.min,
    max: aggregate.max,
    avg:
      aggregate.samples === 0
        ? null
        : Number((aggregate.sum / aggregate.samples).toFixed(3)),
  };
}

function mapRecord(
  map: Map<string, Record<string, MutableAggregate>>,
  key: string,
): Record<string, MutableAggregate> {
  const current = map.get(key);
  if (current) {
    return current;
  }
  const created: Record<string, MutableAggregate> = {};
  map.set(key, created);
  return created;
}

function mapAggregate(
  record: Record<string, MutableAggregate>,
  key: string,
): MutableAggregate {
  record[key] ??= newAggregate();
  return record[key];
}

function finalizeAggregateRecord(
  record: Record<string, MutableAggregate>,
): Record<string, FinalAggregate> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, finalizeAggregate(value)]),
  );
}

function extractLuid(path: string): string | null {
  return /luid_(0x[0-9a-f]+_0x[0-9a-f]+)/i.exec(path)?.[1].toLowerCase() ?? null;
}

function extractPid(path: string): string | null {
  return /pid_(\d+)/i.exec(path)?.[1] ?? null;
}

function extractEngineType(path: string): string | null {
  const value = /engtype_([^\\)]+)/i.exec(path)?.[1];
  return value ? normalizeMetricName(value) : null;
}

function normalizedCounterMetric(path: string): string {
  const raw = path.split('\\').at(-1) ?? path;
  return normalizeMetricName(raw);
}

function normalizeMetricName(value: string): string {
  return value.trim().toLowerCase().replaceAll(/[^a-z0-9]+/g, '_').replaceAll(/^_|_$/g, '');
}

function maxByPrefix(
  record: Record<string, FinalAggregate>,
  prefix: string,
): number | null {
  const values = Object.entries(record)
    .filter(([key]) => key.startsWith(prefix))
    .map(([, aggregate]) => aggregate.max)
    .filter((value): value is number => value !== null);
  return values.length === 0 ? null : Math.max(...values);
}
