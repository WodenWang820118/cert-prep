import type {
  MutableAggregate,
  ResourceCsvRow,
  WindowsResourceSummary,
} from './resource-sampling-types.mts';
import {
  addAggregate,
  extractEngineType,
  extractLuid,
  extractPid,
  finalizeAggregate,
  finalizeAggregateRecord,
  isResourceCsvRow,
  mapAggregate,
  mapRecord,
  newAggregate,
  normalizedCounterMetric,
  parseCsv,
  resourceCsvRow,
} from './resource-sampling-csv.mts';

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
