import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';

import { resolveWindowsPowerShellExecutable } from './processes.mts';
import { errorMessage, normalizePath } from './text-utils.mts';
import type { ResourceSamplingArtifacts } from './types.mts';

const RESOURCE_SAMPLE_INTERVAL_MS = 1_000;
const WINDOWS_RESOURCE_SCRIPT_NAME = 'windows-resource-sampling.ps1';
const RESOURCE_SAMPLER_GRACE_MS = 5_000;
const RESOURCE_SAMPLER_FORCE_MS = 5_000;

interface StartResourceSamplingOptions {
  readonly skipGpuSampling: boolean;
  readonly outDir: string;
  readonly workspaceRoot: string;
  readonly observe: (message: string) => void;
}

export interface ResourceSamplingRun {
  readonly artifacts: ResourceSamplingArtifacts;
  stop(): Promise<void>;
}

interface WindowsResourceScriptOptions {
  readonly csvPath: string;
  readonly summaryPath: string;
  readonly intervalMs: number;
}

interface DxgiAdapter {
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

interface ResourceCsvRow {
  readonly timestamp: string;
  readonly source: string;
  readonly path: string;
  readonly pid: string;
  readonly name: string;
  readonly metric: string;
  readonly value: string;
  readonly unit: string;
}

interface MutableAggregate {
  samples: number;
  sum: number;
  min: number | null;
  max: number | null;
}

interface FinalAggregate {
  samples: number;
  min: number | null;
  max: number | null;
  avg: number | null;
}

interface NvidiaSmiRow {
  readonly utilizationGpuPercent: number | null;
  readonly memoryUsedMiB: number | null;
  readonly memoryTotalMiB: number | null;
  readonly powerDrawW: number | null;
}

const NVIDIA_OCR_PROCESS_MEMORY_GATE_BYTES = 64 * 1024 * 1024;

interface WindowsResourceSummary {
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

interface ResourceSamplerStopResult {
  readonly pid: number | null;
  readonly exit_code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly graceful: boolean;
  readonly forced: boolean;
  readonly stopped: boolean;
  readonly error: string | null;
}

interface ResourceSamplerStopSummary {
  readonly started_at: string;
  readonly finished_at: string;
  readonly duration_ms: number;
  readonly child_count: number;
  readonly stopped_count: number;
  readonly forced_count: number;
  readonly error_count: number;
  readonly results: ResourceSamplerStopResult[];
}

/** Starts best-effort GPU/CPU/RSS telemetry for packaged flow evidence. */
export function startResourceSampling({
  skipGpuSampling,
  outDir,
  workspaceRoot,
  observe,
}: StartResourceSamplingOptions): ResourceSamplingRun {
  const children: ChildProcess[] = [];
  const artifacts: ResourceSamplingArtifacts = {};

  if (skipGpuSampling) {
    return {
      artifacts,
      async stop() {
        return;
      },
    };
  }

  const nvidia = startNvidiaSmiSampling({
    outDir,
    workspaceRoot,
    artifacts,
    observe,
  });
  if (nvidia) {
    children.push(nvidia);
  }

  const windowsSampler = startWindowsResourceSampling({
    outDir,
    workspaceRoot,
    artifacts,
    observe,
  });
  if (windowsSampler) {
    children.push(windowsSampler);
  }

  return {
    artifacts,
    async stop() {
      const samplerStopSummary = await stopResourceSamplerChildren(
        children,
        observe,
      );
      finalizeResourceSamplingArtifacts({
        outDir,
        workspaceRoot,
        artifacts,
        observe,
        samplerStopSummary,
      });
    },
  };
}

function startNvidiaSmiSampling({
  outDir,
  workspaceRoot,
  artifacts,
  observe,
}: {
  readonly outDir: string;
  readonly workspaceRoot: string;
  readonly artifacts: ResourceSamplingArtifacts;
  readonly observe: (message: string) => void;
}): ChildProcess | null {
  const csvPath = join(outDir, 'nvidia-smi.csv');
  const stderrPath = join(outDir, 'nvidia-smi.stderr.log');
  try {
    const child = spawn(
      'nvidia-smi',
      [
        '--query-gpu=timestamp,utilization.gpu,memory.used,memory.total,power.draw',
        '--format=csv',
        '-l',
        '1',
      ],
      { cwd: workspaceRoot, windowsHide: true },
    );
    child.stdout?.pipe(createWriteStream(csvPath));
    child.stderr?.on('data', (chunk) => appendFileSync(stderrPath, chunk));
    child.on('error', (error) => {
      observe(`nvidia-smi unavailable: ${error.message}`);
    });
    artifacts.nvidia_smi_csv = normalizePath(relative(workspaceRoot, csvPath));
    artifacts.nvidia_smi_stderr_log = normalizePath(
      relative(workspaceRoot, stderrPath),
    );
    return child;
  } catch (error) {
    observe(`nvidia-smi unavailable: ${errorMessage(error)}`);
    return null;
  }
}

function startWindowsResourceSampling({
  outDir,
  workspaceRoot,
  artifacts,
  observe,
}: {
  readonly outDir: string;
  readonly workspaceRoot: string;
  readonly artifacts: ResourceSamplingArtifacts;
  readonly observe: (message: string) => void;
}): ChildProcess | null {
  if (process.platform !== 'win32') {
    observe('Windows resource sampling skipped on non-Windows platform.');
    return null;
  }

  const csvPath = join(outDir, 'windows-resource-sampling.csv');
  const summaryPath = join(outDir, 'windows-resource-summary.json');
  const dxgiAdaptersPath = join(outDir, 'windows-dxgi-adapters.json');
  const scriptPath = join(outDir, WINDOWS_RESOURCE_SCRIPT_NAME);
  const stderrPath = join(outDir, 'windows-resource-sampling.stderr.log');
  writeDxgiAdapters({
    outputPath: dxgiAdaptersPath,
    workspaceRoot,
    artifacts,
    observe,
  });
  writeFileSync(
    scriptPath,
    windowsResourceSamplingScript({
      csvPath,
      summaryPath,
      intervalMs: RESOURCE_SAMPLE_INTERVAL_MS,
    }),
    'utf8',
  );

  try {
    const child = spawn(
      resolveWindowsPowerShellExecutable(),
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { cwd: workspaceRoot, windowsHide: true },
    );
    child.stderr?.on('data', (chunk) => appendFileSync(stderrPath, chunk));
    child.on('error', (error) => {
      observe(`Windows resource sampling unavailable: ${error.message}`);
    });
    artifacts.windows_counters_csv = normalizePath(
      relative(workspaceRoot, csvPath),
    );
    artifacts.windows_summary_json = normalizePath(
      relative(workspaceRoot, summaryPath),
    );
    artifacts.windows_dxgi_adapters_json = normalizePath(
      relative(workspaceRoot, dxgiAdaptersPath),
    );
    return child;
  } catch (error) {
    observe(`Windows resource sampling unavailable: ${errorMessage(error)}`);
    return null;
  }
}

function writeDxgiAdapters({
  outputPath,
  workspaceRoot,
  artifacts,
  observe,
}: {
  readonly outputPath: string;
  readonly workspaceRoot: string;
  readonly artifacts: ResourceSamplingArtifacts;
  readonly observe: (message: string) => void;
}): void {
  const result = spawnSync(
    resolveWindowsPowerShellExecutable(),
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      dxgiAdapterProbeScript(outputPath),
    ],
    { cwd: workspaceRoot, windowsHide: true },
  );
  if (result.error) {
    observe(`DXGI adapter probe unavailable: ${result.error.message}`);
  } else if (result.status !== 0) {
    observe(
      `DXGI adapter probe exited ${result.status}: ${String(result.stderr || result.stdout).trim()}`,
    );
  }
  artifacts.windows_dxgi_adapters_json = normalizePath(
    relative(workspaceRoot, outputPath),
  );
}

export function dxgiAdapterProbeScript(outputPath: string): string {
  return `$ErrorActionPreference = 'Stop'
$outputPath = ${psString(outputPath)}
$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct LUID {
  public uint LowPart;
  public int HighPart;
}

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct DXGI_ADAPTER_DESC1 {
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
  public string Description;
  public uint VendorId;
  public uint DeviceId;
  public uint SubSysId;
  public uint Revision;
  public UIntPtr DedicatedVideoMemory;
  public UIntPtr DedicatedSystemMemory;
  public UIntPtr SharedSystemMemory;
  public LUID AdapterLuid;
  public uint Flags;
}

[ComImport, Guid("770aae78-f26f-4dba-a829-253c83d1b387"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IDXGIFactory1 {
  [PreserveSig] int SetPrivateData(ref Guid Name, uint DataSize, IntPtr pData);
  [PreserveSig] int SetPrivateDataInterface(ref Guid Name, IntPtr pUnknown);
  [PreserveSig] int GetPrivateData(ref Guid Name, ref uint pDataSize, IntPtr pData);
  [PreserveSig] int GetParent(ref Guid riid, out IntPtr ppParent);
  [PreserveSig] int EnumAdapters(uint Adapter, out IntPtr ppAdapter);
  [PreserveSig] int MakeWindowAssociation(IntPtr WindowHandle, uint Flags);
  [PreserveSig] int GetWindowAssociation(out IntPtr pWindowHandle);
  [PreserveSig] int CreateSwapChain(IntPtr pDevice, IntPtr pDesc, out IntPtr ppSwapChain);
  [PreserveSig] int CreateSoftwareAdapter(IntPtr Module, out IntPtr ppAdapter);
  [PreserveSig] int EnumAdapters1(uint Adapter, out IDXGIAdapter1 ppAdapter);
  [PreserveSig] int IsCurrent();
}

[ComImport, Guid("29038f61-3839-4626-91fd-086879011a05"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IDXGIAdapter1 {
  [PreserveSig] int SetPrivateData(ref Guid Name, uint DataSize, IntPtr pData);
  [PreserveSig] int SetPrivateDataInterface(ref Guid Name, IntPtr pUnknown);
  [PreserveSig] int GetPrivateData(ref Guid Name, ref uint pDataSize, IntPtr pData);
  [PreserveSig] int GetParent(ref Guid riid, out IntPtr ppParent);
  [PreserveSig] int EnumOutputs(uint Output, out IntPtr ppOutput);
  [PreserveSig] int GetDesc(out DXGI_ADAPTER_DESC1 desc);
  [PreserveSig] int CheckInterfaceSupport(ref Guid InterfaceName, out long pUMDVersion);
  [PreserveSig] int GetDesc1(out DXGI_ADAPTER_DESC1 desc);
}

public static class DxgiProbe {
  [DllImport("dxgi.dll")]
  public static extern int CreateDXGIFactory1(ref Guid riid, out IDXGIFactory1 ppFactory);

  public static DxgiAdapterInfo[] GetAdapters() {
    Guid iid = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
    IDXGIFactory1 factory;
    int hr = CreateDXGIFactory1(ref iid, out factory);
    if (hr != 0 || factory == null) {
      throw new Exception("CreateDXGIFactory1 failed with HRESULT " + hr);
    }
    List<DxgiAdapterInfo> adapters = new List<DxgiAdapterInfo>();
    for (uint index = 0; index < 32; index++) {
      IDXGIAdapter1 adapter;
      int enumHr = factory.EnumAdapters1(index, out adapter);
      if (enumHr != 0 || adapter == null) {
        break;
      }
      DXGI_ADAPTER_DESC1 desc;
      int descHr = adapter.GetDesc1(out desc);
      if (descHr != 0) {
        continue;
      }
      adapters.Add(new DxgiAdapterInfo {
        adapter_index = index,
        luid = string.Format(
          "0x{0:x8}_0x{1:x8}",
          desc.AdapterLuid.HighPart,
          desc.AdapterLuid.LowPart
        ).ToLowerInvariant(),
        description = desc.Description,
        vendor_id = string.Format("0x{0:x4}", desc.VendorId),
        device_id = string.Format("0x{0:x4}", desc.DeviceId),
        dedicated_video_memory_bytes = desc.DedicatedVideoMemory.ToUInt64(),
        dedicated_system_memory_bytes = desc.DedicatedSystemMemory.ToUInt64(),
        shared_system_memory_bytes = desc.SharedSystemMemory.ToUInt64()
      });
    }
    return adapters.ToArray();
  }
}

public class DxgiAdapterInfo {
  public uint adapter_index;
  public string luid;
  public string description;
  public string vendor_id;
  public string device_id;
  public ulong dedicated_video_memory_bytes;
  public ulong dedicated_system_memory_bytes;
  public ulong shared_system_memory_bytes;
}
'@
try {
  Add-Type -TypeDefinition $source -ErrorAction Stop
  $adapters = @([DxgiProbe]::GetAdapters() | ForEach-Object {
    $kind = if ($_.description -match 'AMD|Radeon') {
      'amd_igpu'
    } elseif ($_.description -match 'NVIDIA|GeForce|RTX') {
      'nvidia_dgpu'
    } elseif ($_.description -match 'Microsoft Basic Render') {
      'software'
    } else {
      'unknown'
    }
    [pscustomobject]@{
      luid = $_.luid
      adapter_index = [int]$_.adapter_index
      description = $_.description
      vendor_id = $_.vendor_id
      device_id = $_.device_id
      dedicated_video_memory_bytes = [uint64]$_.dedicated_video_memory_bytes
      dedicated_system_memory_bytes = [uint64]$_.dedicated_system_memory_bytes
      shared_system_memory_bytes = [uint64]$_.shared_system_memory_bytes
      adapter_kind = $kind
    }
  })
  [pscustomobject]@{
    status = 'completed'
    generated_at = (Get-Date).ToUniversalTime().ToString('o')
    adapters = $adapters
  } | ConvertTo-Json -Depth 8 | Set-Content -Path $outputPath -Encoding utf8
} catch {
  [pscustomobject]@{
    status = 'unavailable'
    generated_at = (Get-Date).ToUniversalTime().ToString('o')
    error = $_.Exception.Message
    adapters = @()
  } | ConvertTo-Json -Depth 8 | Set-Content -Path $outputPath -Encoding utf8
}
`;
}

export function windowsResourceSamplingScript({
  csvPath,
  summaryPath,
  intervalMs,
}: WindowsResourceScriptOptions): string {
  return `$ErrorActionPreference = 'Stop'
$csvPath = ${psString(csvPath)}
$summaryPath = ${psString(summaryPath)}
$intervalMs = ${intervalMs}
$targetProcessNames = @(
  'exam-prep-desktop.exe',
  'exam-prep-backend.exe',
  'exam-prep-ocr-runtime.exe',
  'exam-prep-ocr-directml-runtime.exe',
  'llama-server.exe',
  'ollama.exe',
  'ollama app.exe',
  'ollama_llama_server.exe',
  'python.exe',
  'pythonw.exe'
)
$gpuCounters = @(
  '\\GPU Adapter Memory(*)\\Dedicated Usage',
  '\\GPU Adapter Memory(*)\\Shared Usage',
  '\\GPU Adapter Memory(*)\\Total Committed',
  '\\GPU Process Memory(*)\\Dedicated Usage',
  '\\GPU Process Memory(*)\\Shared Usage',
  '\\GPU Process Memory(*)\\Total Committed',
  '\\GPU Engine(*)\\Utilization Percentage'
)
function New-ResourceRow($timestamp, $source, $path, $pidValue, $name, $metric, $value, $unit) {
  [pscustomobject]@{
    timestamp = $timestamp
    source = $source
    path = $path
    pid = $pidValue
    name = $name
    metric = $metric
    value = $value
    unit = $unit
  }
}

function Add-Rows($rows) {
  if ($rows.Count -gt 0) {
    $rows | ConvertTo-Csv -NoTypeInformation | Select-Object -Skip 1 | Add-Content -Path $csvPath -Encoding utf8
  }
}
$summary = [ordered]@{
  generated_at = (Get-Date).ToUniversalTime().ToString('o')
  sample_interval_ms = $intervalMs
  target_process_names = $targetProcessNames
  video_controllers = @(Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion,PNPDeviceID)
  gpu_counter_sets = @(Get-Counter -ListSet GPU* | Select-Object -ExpandProperty CounterSetName)
  gpu_counters = $gpuCounters
}
$summary | ConvertTo-Json -Depth 8 | Set-Content -Path $summaryPath -Encoding utf8
'timestamp,source,path,pid,name,metric,value,unit' | Set-Content -Path $csvPath -Encoding utf8
while ($true) {
  $timestamp = (Get-Date).ToUniversalTime().ToString('o')
  $rows = @()
  try {
    $cpu = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'"
    $rows += New-ResourceRow $timestamp 'windows_cpu' 'Win32_PerfFormattedData_PerfOS_Processor' '' '_Total' 'percent_processor_time' ([double]$cpu.PercentProcessorTime) 'percent'
  } catch {
    $rows += New-ResourceRow $timestamp 'error' 'Win32_PerfFormattedData_PerfOS_Processor' '' '' 'cpu_sample_error' $_.Exception.Message 'text'
  }
  try {
    $processes = Get-CimInstance Win32_Process | Where-Object { $targetProcessNames -contains $_.Name }
    foreach ($process in $processes) {
      $workingSet = if ($null -eq $process.WorkingSetSize) { 0 } else { [double]$process.WorkingSetSize }
      $privatePageCount = if ($null -eq $process.PrivatePageCount) { 0 } else { [double]$process.PrivatePageCount }
      $rows += New-ResourceRow $timestamp 'windows_process' 'Win32_Process' $process.ProcessId $process.Name 'working_set_bytes' $workingSet 'bytes'
      $rows += New-ResourceRow $timestamp 'windows_process' 'Win32_Process' $process.ProcessId $process.Name 'private_page_count_bytes' $privatePageCount 'bytes'
    }
  } catch {
    $rows += New-ResourceRow $timestamp 'error' 'Win32_Process' '' '' 'process_sample_error' $_.Exception.Message 'text'
  }
  try {
    $samples = Get-Counter -Counter $gpuCounters -ErrorAction Stop
    foreach ($sample in $samples.CounterSamples) {
      $rows += New-ResourceRow $timestamp 'windows_gpu_counter' $sample.Path '' '' $sample.Path ([double]$sample.CookedValue) 'raw'
    }
  } catch {
    $rows += New-ResourceRow $timestamp 'error' 'Get-Counter' '' '' 'gpu_counter_sample_error' $_.Exception.Message 'text'
  }
  Add-Rows $rows
  Start-Sleep -Milliseconds $intervalMs
}
`;
}

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
async function stopResourceSamplerChildren(
  children: readonly ChildProcess[],
  observe: (message: string) => void,
): Promise<ResourceSamplerStopSummary> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const results = await Promise.all(
    children.map(async (child) => {
      const result = await stopChildProcess(child).catch((error) => ({
        pid: child.pid ?? null,
        exit_code: child.exitCode,
        signal: child.signalCode,
        graceful: false,
        forced: false,
        stopped: false,
        error: errorMessage(error),
      }));
      if (!result.stopped || result.error) {
        observe(
          `resource sampler stop issue pid=${result.pid ?? 'unknown'} stopped=${result.stopped}: ${result.error ?? 'process did not report exit'}`,
        );
      }
      return result;
    }),
  );
  const finishedAtMs = Date.now();
  return {
    started_at: startedAt,
    finished_at: new Date(finishedAtMs).toISOString(),
    duration_ms: finishedAtMs - startedAtMs,
    child_count: children.length,
    stopped_count: results.filter((result) => result.stopped).length,
    forced_count: results.filter((result) => result.forced).length,
    error_count: results.filter((result) => result.error !== null).length,
    results,
  };
}

async function stopChildProcess(
  child: ChildProcess,
): Promise<ResourceSamplerStopResult> {
  const pid = child.pid ?? null;
  if (child.exitCode !== null) {
    return {
      pid,
      exit_code: child.exitCode,
      signal: child.signalCode,
      graceful: true,
      forced: false,
      stopped: true,
      error: null,
    };
  }
  child.kill();
  if (await waitForExit(child, RESOURCE_SAMPLER_GRACE_MS)) {
    return {
      pid,
      exit_code: child.exitCode,
      signal: child.signalCode,
      graceful: true,
      forced: false,
      stopped: true,
      error: null,
    };
  }
  const forceResult =
    pid === null ? 'child process had no pid' : terminateSamplerProcessTree(pid);
  const stopped = await waitForExit(child, RESOURCE_SAMPLER_FORCE_MS);
  return {
    pid,
    exit_code: child.exitCode,
    signal: child.signalCode,
    graceful: false,
    forced: true,
    stopped,
    error: stopped ? forceResult : forceResult ?? 'process did not exit after force stop',
  };
}

function terminateSamplerProcessTree(pid: number): string | null {
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: RESOURCE_SAMPLER_FORCE_MS,
    });
    if (result.error) {
      return result.error.message;
    }
    if (result.status !== 0) {
      return `taskkill exited ${result.status ?? 'unknown'}`;
    }
    return null;
  }

  try {
    process.kill(pid, 'SIGTERM');
    return null;
  } catch (error) {
    return errorMessage(error);
  }
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null) {
    return true;
  }
  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function psString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
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
