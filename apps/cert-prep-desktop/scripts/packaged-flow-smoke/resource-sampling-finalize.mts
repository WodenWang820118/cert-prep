import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { errorMessage } from './text-utils.mts';
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
import { summarizeWindowsResourceCsv } from './resource-sampling-windows-summary.mts';

export function finalizeResourceSamplingArtifacts({
  outDir,
  artifacts,
  observe,
  samplerStopSummary = null,
}: {
  readonly outDir: string;
  readonly artifacts: ResourceSamplingArtifacts;
  readonly observe: (message: string) => void;
  readonly samplerStopSummary?: ResourceSamplerStopSummary | null;
}): void {
  const summaryPath = join(outDir, 'windows-resource-summary.json');
  const windowsCsvPath = join(outDir, 'windows-resource-sampling.csv');
  const windowsScriptPath = join(outDir, 'windows-resource-sampling.ps1');
  const dxgiAdaptersPath = join(outDir, 'windows-dxgi-adapters.json');
  let failure: unknown = null;

  try {
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
        'Windows GPU counters expose adapter LUIDs. DXGI adapter metadata maps those runtime LUIDs to generic adapter identities when available.',
      artifacts,
      raw_sampling_artifacts_removed_after_finalize: true,
      sampler_stop: samplerStopSummary,
      dxgi_adapters: dxgiAdapters,
      gpu_luid_map_status: gpuLuidMapStatus(
        windowsResourceSummary,
        dxgiAdapters,
      ),
      unmapped_gpu_luids: unmappedGpuLuids(
        windowsResourceSummary,
        dxgiAdapters,
      ),
      windows_resource_summary: windowsResourceSummary,
      ...(adapterAwareSummary ?? {}),
    };
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  } catch (error) {
    observe(`resource summary finalize failed: ${errorMessage(error)}`);
    failure = error;
  }

  try {
    rmSync(windowsCsvPath, { force: true });
    rmSync(windowsScriptPath, { force: true });
  } catch (error) {
    observe(`private resource sampling cleanup failed: ${errorMessage(error)}`);
    failure ??= error;
  }

  if (failure !== null) {
    throw failure;
  }
}
