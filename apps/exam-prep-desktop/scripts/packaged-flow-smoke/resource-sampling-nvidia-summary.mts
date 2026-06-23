import {
  addOptionalAggregate,
  finalizeAggregate,
  isNvidiaSmiRow,
  newAggregate,
  nvidiaSmiRow,
  parseCsv,
} from './resource-sampling-csv.mts';

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
