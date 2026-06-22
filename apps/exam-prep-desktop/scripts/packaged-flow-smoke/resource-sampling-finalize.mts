import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { errorMessage, normalizePath } from './text-utils.mts';
import type { ResourceSamplingArtifacts } from './types.mts';
import type { ResourceSamplerStopSummary } from './resource-sampling-types.mts';
import { summarizeGpuByAdapter } from './resource-sampling-gpu-routing.mts';
import {
  gpuLuidMapStatus,
  isRecord,
  readDxgiAdapters,
  readJsonFile,
  unmappedGpuLuids,
} from './resource-sampling-json.mts';
import { summarizeNvidiaSmiCsv } from './resource-sampling-nvidia-summary.mts';
import { summarizeWindowsResourceCsv } from './resource-sampling-windows-summary.mts';

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
