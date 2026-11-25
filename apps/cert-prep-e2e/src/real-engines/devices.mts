/**
 * Device samples for one real-engine phase.
 *
 * The pure half parses the Windows GPU engine counters (per process and adapter
 * LUID), nvidia-smi, and CPU, then decides whether the designed device, the
 * device Cert reported, and the device the samples observed are the same.
 * A phase without enough busy samples is "not observed".
 *
 * The command half is what the journey runs: `adapters` reads the DirectX
 * registry, `sample` records one phase, and `verdict` prints the decision.
 * Nothing here prints a bearer token or recognized text.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { SAMPLE_STOP_TIMEOUT_MS, SHORT_COMMAND_TIMEOUT_MS, WINDOWS_SCRIPT_TIMEOUT_MS } from './budgets.mts';

export type AdapterClass = 'dedicated' | 'integrated' | 'software';
export type ObservedDevice = 'dedicated-gpu' | 'integrated-gpu' | 'cpu';
export type PhaseVerdict = 'pass' | 'mismatch' | 'not observed';

export const NVIDIA_VENDOR_ID = 0x10de;
export const MICROSOFT_VENDOR_ID = 0x1414;
/** Discrete adapters report at least this much dedicated video memory. */
export const DEDICATED_VIDEO_BYTES = 512n * 1024n * 1024n;

export interface GpuAdapter {
  /** 16 lowercase hex digits: high part, then low part. */
  readonly luid: string;
  readonly adapterClass: AdapterClass;
  readonly description: string;
  readonly vendorId: number | null;
}

export interface GpuSample {
  readonly time: string;
  readonly owned: boolean;
  readonly luid: string;
  readonly engineType: string;
  readonly utilization: number;
  readonly worker: string;
}

export interface CpuSample {
  readonly time: string;
  readonly ownedCpuSeconds: number;
  readonly totalPercent: number;
  readonly ownedProcesses: number;
  readonly gpuOk: boolean;
}

export interface NvidiaSample {
  readonly time: string;
  readonly utilization: number;
  readonly memoryUsedMiB: number;
}

export interface GpuBusySample {
  readonly time: string;
  /** One engine of one process: pid, LUID and engine index. */
  readonly engine: string;
  readonly luid: string;
  readonly engineType: string;
  /** Cumulative busy time in 100 ns units. */
  readonly runningTime: number;
  readonly worker: string;
}

interface WorkerSample {
  readonly time: string;
  readonly pid: string;
  readonly worker: string;
  readonly seconds: number;
}

export interface RegistryAdapter {
  readonly luidQword: string;
  readonly dedicatedVideoBytes: string;
  readonly vendorId: string;
  readonly description: string;
}

/** High 32 bits then low 32 bits, matching `luid_0x<high>_0x<low>` counter names. */
export function formatAdapterLuid(qword: bigint): string {
  if (qword < 0n || qword > 0xffffffffffffffffn) {
    throw new Error('Adapter LUID is out of range.');
  }
  const high = (qword >> 32n) & 0xffffffffn;
  const low = qword & 0xffffffffn;
  return high.toString(16).padStart(8, '0') + low.toString(16).padStart(8, '0');
}

export function classifyAdapter(input: {
  readonly vendorId: number;
  readonly dedicatedVideoBytes: bigint;
  readonly description: string;
}): AdapterClass {
  if (
    input.vendorId === MICROSOFT_VENDOR_ID ||
    /microsoft basic render driver/iu.test(input.description)
  ) {
    return 'software';
  }
  if (input.dedicatedVideoBytes >= DEDICATED_VIDEO_BYTES) return 'dedicated';
  return 'integrated';
}

export function adaptersFromRegistry(records: readonly RegistryAdapter[]): readonly GpuAdapter[] {
  const seen = new Set<string>();
  const adapters: GpuAdapter[] = [];
  for (const record of records) {
    if (!/^\d+$/u.test(record.luidQword) || !/^\d+$/u.test(record.dedicatedVideoBytes)) continue;
    const luid = formatAdapterLuid(BigInt(record.luidQword));
    if (seen.has(luid)) continue;
    seen.add(luid);
    const vendorId = /^\d+$/u.test(record.vendorId) ? Number(record.vendorId) : null;
    adapters.push({
      luid,
      adapterClass: classifyAdapter({
        vendorId: vendorId ?? 0,
        dedicatedVideoBytes: BigInt(record.dedicatedVideoBytes),
        description: record.description,
      }),
      description: record.description,
      vendorId,
    });
  }
  return adapters;
}

/**
 * Reads the Windows sampler's lines:
 * `gpu,<time>,<owned|other>,<luid>,<engine type>,<utilization %>,<worker>`,
 * `busy,<time>,<pid:ticks>,<luid>,<engine index>,<engine type>,<running time>,<worker>`,
 * `worker,<time>,<pid:ticks>,<worker>,<CPU seconds>`,
 * and `cpu,<time>,<owned CPU seconds>,<total CPU %>,<owned process count>,<gpuOk>`.
 */
export function parseWindowsSamples(text: string): {
  readonly gpu: readonly GpuSample[];
  readonly busy: readonly GpuBusySample[];
  readonly cpu: readonly CpuSample[];
  readonly workers: readonly WorkerSample[];
} {
  const gpu: GpuSample[] = [];
  const busy: GpuBusySample[] = [];
  const cpu: CpuSample[] = [];
  const workers: WorkerSample[] = [];
  for (const line of text.replace(/^\uFEFF/u, '').split(/\r?\n/u)) {
    const fields = line.trim().split(',');
    if (fields[0] === 'busy' && fields.length === 8) {
      const runningTime = Number(fields[6]);
      if (/^\d+:\d+$/u.test(fields[2] ?? '') && /^[0-9a-f]{16}$/u.test(fields[3] ?? '') && Number.isFinite(runningTime)) {
        busy.push({
          time: fields[1] ?? '',
          engine: `${fields[2]}:${fields[3]}:${fields[4]}`,
          luid: fields[3] ?? '',
          engineType: fields[5] ?? '',
          runningTime,
          worker: fields[7] ?? '',
        });
      }
    } else if (fields[0] === 'gpu' && fields.length === 7) {
      const utilization = Number(fields[5]);
      if (
        (fields[2] === 'owned' || fields[2] === 'other') &&
        /^[0-9a-f]{16}$/u.test(fields[3] ?? '') &&
        Number.isFinite(utilization)
      ) {
        gpu.push({
          time: fields[1] ?? '',
          owned: fields[2] === 'owned',
          luid: fields[3] ?? '',
          engineType: fields[4] ?? '',
          utilization,
          worker: fields[6] ?? '',
        });
      }
    } else if (fields[0] === 'cpu' && fields.length === 6) {
      const values = fields.slice(2, 5).map(Number);
      if (values.every(Number.isFinite)) {
        cpu.push({
          time: fields[1] ?? '',
          ownedCpuSeconds: values[0] ?? 0,
          totalPercent: values[1] ?? 0,
          ownedProcesses: values[2] ?? 0,
          gpuOk: fields[5] === 'True',
        });
      }
    } else if (
      fields[0] === 'worker' &&
      fields.length === 5 &&
      /^\d+:\d+$/u.test(fields[2] ?? '') &&
      /^\d+(\.\d+)?$/u.test(fields[4] ?? '')
    ) {
      workers.push({
        time: fields[1] ?? '',
        pid: fields[2] ?? '',
        worker: fields[3] ?? '',
        seconds: Number(fields[4]),
      });
    }
  }
  return { gpu, busy, cpu, workers };
}

/** Reads `nvidia-smi --query-gpu=timestamp,utilization.gpu,memory.used --format=csv,noheader,nounits`. */
export function parseNvidiaSamples(text: string): readonly NvidiaSample[] {
  const samples: NvidiaSample[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const fields = line.split(',').map((field) => field.trim());
    if (fields.length !== 3) continue;
    const utilization = Number(fields[1]);
    const memoryUsedMiB = Number(fields[2]);
    const time = (fields[0] ?? '').replace(/^\uFEFF/u, '');
    if (time && Number.isFinite(utilization) && Number.isFinite(memoryUsedMiB)) {
      samples.push({ time, utilization, memoryUsedMiB });
    }
  }
  return samples;
}

// Engines that do the work of a model: 3D and compute queues (DirectML and
// CUDA submit there). Copy engines only move data.
const workEngineTypes = /^(3d|compute|cuda)/iu;
// An adapter counts as used when the runtime's engines were busy on it for at
// least this long, or when it shows in this many samples at this utilization.
// The runtime's own adapter probe touches the GPU only briefly.
export const BUSY_SECONDS = 0.5;
export const ACTIVE_UTILIZATION_PERCENT = 5;
export const ACTIVE_SAMPLE_COUNT = 2;

export interface AdapterUse {
  readonly luid: string;
  readonly adapterClass: AdapterClass | 'unknown';
  readonly description: string;
  readonly vendorId: number | null;
  readonly busySeconds: number;
  readonly activeSamples: number;
  readonly maxUtilization: number;
}

/** Busy seconds of the sampled work engines per adapter over the sampled span. */
function busySecondsByAdapter(samples: readonly GpuBusySample[], baselineTime: string | undefined): Map<string, number> {
  const engines = new Map<string, { last: number; time: number }>();
  const byAdapter = new Map<string, number>();
  const baselineMs = Date.parse(baselineTime ?? '');
  for (const sample of samples) {
    const engine = engines.get(sample.engine);
    const time = Date.parse(sample.time);
    let seconds = 0;
    if (!engine) {
      // Windows has reported a negative start as unsigned, near 2^64.
      // Only a plausible process-age total starts at zero.
      // CreationDate.Ticks uses 100 ns since year 1, not the Unix epoch.
      const startMs = Number(BigInt(sample.engine.split(':')[1] ?? '0') / 10_000n) - 62_135_596_800_000;
      const ageSeconds = (time - startMs) / 1000;
      const initialSeconds = sample.runningTime / 1e7;
      if (startMs >= baselineMs && time > baselineMs && initialSeconds >= 0 && initialSeconds <= ageSeconds) {
        seconds = initialSeconds;
      }
    } else if (sample.runningTime >= engine.last) {
      const elapsedSeconds = Math.max(0, (time - engine.time) / 1000);
      if (Number.isFinite(elapsedSeconds)) {
        seconds = Math.min((sample.runningTime - engine.last) / 1e7, elapsedSeconds);
      }
    }
    engines.set(sample.engine, { last: sample.runningTime, time });
    byAdapter.set(sample.luid, (byAdapter.get(sample.luid) ?? 0) + seconds);
  }
  return byAdapter;
}

export interface DeviceObservation {
  readonly sampleCount: number;
  readonly ownedAdapterUse: readonly AdapterUse[];
  readonly ownedCpuSeconds: number;
  readonly maxTotalCpuPercent: number;
  readonly nvidiaSampleCount: number;
  readonly nvidiaMaxUtilization: number | null;
  readonly nvidiaMemoryRiseMiB: number | null;
  readonly observedDevice: ObservedDevice | null;
  readonly matchingProcessObserved: boolean;
  readonly conflictingAdapters: boolean;
}

export function summarizeObservation(input: {
  readonly gpu: readonly GpuSample[];
  readonly busy?: readonly GpuBusySample[];
  readonly cpu: readonly CpuSample[];
  readonly nvidia: readonly NvidiaSample[];
  readonly adapters: readonly GpuAdapter[];
  readonly workers: readonly WorkerSample[];
  readonly worker?: string;
}): DeviceObservation {
  const baselineTime = input.cpu[0]?.time;
  const ticks = new Set(input.cpu.map((sample) => sample.time));
  const matches = (sample: { readonly time: string; readonly worker: string }) =>
    ticks.has(sample.time) && (input.worker === undefined || sample.worker === input.worker);
  const workers = input.workers.filter(matches);
  const processes = new Map<string, { baseline: number; last: number }>();
  for (const sample of workers) {
    const process = processes.get(sample.pid);
    if (process) process.last = Math.max(process.last, sample.seconds);
    else processes.set(sample.pid, { baseline: sample.time === baselineTime ? sample.seconds : 0, last: sample.seconds });
  }
  const workerSeconds = [...processes.values()].reduce((total, process) => total + process.last - process.baseline, 0);
  const perTick = new Map<string, Map<string, number>>();
  for (const sample of input.gpu) {
    if (!sample.owned || !matches(sample) || sample.time === baselineTime || !workEngineTypes.test(sample.engineType)) continue;
    const byLuid = perTick.get(sample.time) ?? new Map<string, number>();
    byLuid.set(sample.luid, Math.min(100, Math.max(byLuid.get(sample.luid) ?? 0, sample.utilization)));
    perTick.set(sample.time, byLuid);
  }
  const uses = new Map<string, { active: number; max: number; busySeconds: number }>();
  for (const byLuid of perTick.values()) {
    for (const [luid, utilization] of byLuid) {
      const use = uses.get(luid) ?? { active: 0, max: 0, busySeconds: 0 };
      if (utilization >= ACTIVE_UTILIZATION_PERCENT) use.active += 1;
      use.max = Math.max(use.max, utilization);
      uses.set(luid, use);
    }
  }
  const workerGpu = (input.busy ?? []).filter(matches);
  const anyGpuWork =
    [...busySecondsByAdapter(workerGpu, baselineTime).values()].some((seconds) => seconds > 0) ||
    input.gpu.some((sample) => sample.owned && matches(sample) && sample.time !== baselineTime && sample.utilization > 0);
  for (const [luid, seconds] of busySecondsByAdapter(
    workerGpu.filter((sample) => workEngineTypes.test(sample.engineType)),
    baselineTime,
  )) {
    const use = uses.get(luid) ?? { active: 0, max: 0, busySeconds: 0 };
    use.busySeconds = seconds;
    uses.set(luid, use);
  }
  const ownedAdapterUse: AdapterUse[] = [...uses.entries()]
    .map(([luid, use]): AdapterUse => {
      const adapter = input.adapters.find((item) => item.luid === luid);
      return {
        luid,
        adapterClass: adapter?.adapterClass ?? 'unknown',
        description: adapter?.description ?? '',
        vendorId: adapter?.vendorId ?? null,
        busySeconds: use.busySeconds,
        activeSamples: use.active,
        maxUtilization: Math.round(use.max * 10) / 10,
      };
    })
    .sort((left, right) => right.busySeconds - left.busySeconds || right.activeSamples - left.activeSamples);
  const busy = ownedAdapterUse.filter(
    (use) => use.busySeconds >= BUSY_SECONDS || use.activeSamples >= ACTIVE_SAMPLE_COUNT,
  );
  const sampleCount = input.cpu.length;
  const cpuSeconds = input.cpu.map((sample) => sample.ownedCpuSeconds);
  const complete = sampleCount >= ACTIVE_SAMPLE_COUNT && input.cpu.every((sample) => sample.gpuOk);
  const matchingProcessObserved =
    input.worker === undefined ? input.cpu.some((sample) => sample.ownedProcesses > 0) : workers.length > 0;
  const conflictingAdapters =
    complete &&
    busy.length > 0 &&
    ownedAdapterUse.some((use) => use.luid !== busy[0]?.luid && (use.busySeconds >= 0.05 || use.activeSamples > 0));
  const observedDevice: ObservedDevice | null =
    !complete || !matchingProcessObserved || conflictingAdapters
      ? null
      : busy[0]?.adapterClass === 'dedicated'
        ? 'dedicated-gpu'
        : busy[0]?.adapterClass === 'integrated'
          ? 'integrated-gpu'
          : !anyGpuWork && workerSeconds > 0
            ? 'cpu'
            : null;
  const memory = input.nvidia.map((sample) => sample.memoryUsedMiB);
  return {
    sampleCount,
    ownedAdapterUse,
    ownedCpuSeconds:
      input.worker !== undefined
        ? workerSeconds
        : cpuSeconds.length > 1
          ? Math.round((Math.max(...cpuSeconds) - (cpuSeconds[0] ?? 0)) * 10) / 10
          : 0,
    maxTotalCpuPercent: input.cpu.length ? Math.max(...input.cpu.map((sample) => sample.totalPercent)) : 0,
    nvidiaSampleCount: input.nvidia.length,
    nvidiaMaxUtilization: input.nvidia.length ? Math.max(...input.nvidia.map((sample) => sample.utilization)) : null,
    nvidiaMemoryRiseMiB: memory.length ? Math.max(...memory) - (memory[0] ?? 0) : null,
    observedDevice,
    matchingProcessObserved,
    conflictingAdapters,
  };
}

export interface PhaseDesign {
  readonly device: string;
  readonly observed: ObservedDevice;
  readonly adapterClass?: 'dedicated' | 'integrated';
  readonly model?: string;
  readonly vendor?: 'nvidia';
  readonly server?: string;
  readonly verification?: string;
  readonly backend?: string;
  readonly mode?: string;
}

export interface PhaseReported {
  readonly device?: string | null;
  readonly adapterClass?: string | null;
  readonly model?: string | null;
  readonly server?: string | null;
  readonly verification?: string | null;
  readonly backend?: string | null;
  readonly mode?: string | null;
}

export interface PhaseDecision {
  readonly verdict: PhaseVerdict;
  readonly reasons: readonly string[];
  readonly designed: string;
  readonly reported: string;
  readonly observed: string;
  readonly sampleCount: number;
  readonly nvidiaSampleCount: number;
  readonly nvidiaMaxUtilization: number | null;
}

function designedLabel(design: PhaseDesign): string {
  return [
    design.device,
    design.observed,
    design.adapterClass,
    design.model,
    design.vendor,
    design.server,
    design.verification,
    design.backend,
    design.mode,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' ');
}

function reportedLabel(reported: PhaseReported): string {
  const parts = [
    reported.device,
    reported.adapterClass,
    reported.model,
    reported.server,
    reported.verification,
    reported.backend,
    reported.mode,
  ];
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(' ') || 'not reported';
}

function compareField(
  reasons: string[],
  missing: string[],
  label: string,
  actual: string | null | undefined,
  expected: string | undefined,
): void {
  if (expected === undefined) return;
  if (actual === undefined || actual === null || actual.length === 0) missing.push(`${label} not reported`);
  else if (actual !== expected) reasons.push(`${label} ${actual}, designed ${expected}`);
}

export function decidePhaseVerdict(input: {
  readonly design: PhaseDesign;
  readonly reported: PhaseReported;
  readonly observation?: DeviceObservation | null;
}): PhaseDecision {
  const reasons: string[] = [];
  const missing: string[] = [];
  compareField(reasons, missing, 'device', input.reported.device, input.design.device);
  compareField(reasons, missing, 'adapter', input.reported.adapterClass, input.design.adapterClass);
  compareField(reasons, missing, 'model', input.reported.model, input.design.model);
  compareField(reasons, missing, 'server', input.reported.server, input.design.server);
  compareField(reasons, missing, 'verification', input.reported.verification, input.design.verification);
  compareField(reasons, missing, 'backend', input.reported.backend, input.design.backend);
  compareField(reasons, missing, 'mode', input.reported.mode, input.design.mode);
  const observation = input.observation;
  if (!observation) missing.push('device not observed');
  else if (observation.conflictingAdapters) reasons.push('multiple GPU adapters active');
  else if (!observation.matchingProcessObserved) missing.push('no matching process was sampled');
  else if (!observation.observedDevice) missing.push('device not observed');
  else if (observation.observedDevice !== input.design.observed) {
    reasons.push(`observed ${observation.observedDevice}, designed ${input.design.observed}`);
  } else if (input.design.vendor === 'nvidia') {
    const busyAdapter = observation.ownedAdapterUse.find(
      (use) => use.busySeconds >= BUSY_SECONDS || use.activeSamples >= ACTIVE_SAMPLE_COUNT,
    );
    if (observation.nvidiaSampleCount === 0) missing.push('nvidia-smi produced no samples');
    if (!busyAdapter || busyAdapter.vendorId === null) missing.push('NVIDIA adapter was not identified');
    else if (busyAdapter.vendorId !== NVIDIA_VENDOR_ID) {
      reasons.push(`busy adapter vendor ${String(busyAdapter.vendorId)}, designed NVIDIA`);
    }
  }
  const verdict: PhaseVerdict = reasons.length > 0 ? 'mismatch' : missing.length > 0 ? 'not observed' : 'pass';
  return {
    verdict,
    reasons: [...reasons, ...missing],
    designed: designedLabel(input.design),
    reported: reportedLabel(input.reported),
    observed: observation?.observedDevice ?? 'not observed',
    sampleCount: observation?.sampleCount ?? 0,
    nvidiaSampleCount: observation?.nvidiaSampleCount ?? 0,
    nvidiaMaxUtilization: observation?.nvidiaMaxUtilization ?? null,
  };
}

/**
 * DirectML OCR is designed for the dedicated adapter when one is listed,
 * otherwise the integrated adapter. The runtime's reported class is a separate value.
 */
export function designedOcrAdapterClass(adapterClasses: readonly string[]): 'dedicated' | 'integrated' {
  return adapterClasses.includes('dedicated') ? 'dedicated' : 'integrated';
}

/**
 * A PID may be killed only while Node still has the child and the live process
 * still has the creation time recorded at spawn. Windows reuses PIDs.
 */
export function sameSpawnedProcess(input: {
  readonly stillRunning: boolean;
  readonly recordedCreation: string | null;
  readonly liveCreation: string | null;
}): boolean {
  return (
    input.stillRunning &&
    input.recordedCreation !== null &&
    input.recordedCreation.length > 0 &&
    input.recordedCreation === input.liveCreation
  );
}

export function spawnTimedOut(error: Error | undefined): boolean {
  return error !== undefined && 'code' in error && (error as { readonly code?: unknown }).code === 'ETIMEDOUT';
}

// The sampler and the adapter list are Windows process evidence. The pure
// functions above are what the unit test covers.

const windowsSamplerScript = String.raw`param([int]$RootPid, [int]$OllamaPort, [string]$EngineRoot, [string]$Out, [string]$NvidiaOut, [int]$IntervalSeconds)
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  $time = (Get-Date).ToUniversalTime().ToString('o')
  $gpuOk = $true
  $listener = 0
  if ($OllamaPort -gt 0) {
    $RootPid = 0
    $connections = @(Get-NetTCPConnection -LocalPort $OllamaPort -State Listen -ErrorAction SilentlyContinue)
    foreach ($connection in $connections) {
      $address = [string]$connection.LocalAddress
      if ($address -eq '127.0.0.1' -or $address -eq '0.0.0.0' -or $address -eq '::1') {
        $RootPid = [int]$connection.OwningProcess
        break
      }
    }
  }
  $listener = $RootPid
  $all = @()
  $formatted = @()
  $raw = @()
  try {
    $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine, CreationDate, KernelModeTime, UserModeTime -ErrorAction Stop)
    $formatted = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -Property Name, UtilizationPercentage -ErrorAction Stop)
    $raw = @(Get-CimInstance Win32_PerfRawData_GPUPerformanceCounters_GPUEngine -Property Name, RunningTime -ErrorAction Stop)
  } catch { $gpuOk = $false }
  $owned = [System.Collections.Generic.HashSet[int]]::new()
  if ($RootPid -and ($all | Where-Object ProcessId -eq $RootPid)) { [void]$owned.Add($RootPid) }
  do {
    $changed = $false
    foreach ($process in $all) {
      if ($owned.Contains([int]$process.ParentProcessId) -and $owned.Add([int]$process.ProcessId)) { $changed = $true }
    }
  } while ($changed)
  $lines = @()
  $attribution = @{}
  $identities = @{}
  $cpuSeconds = 0.0
  $childCount = 0
  if ($listener -ne 0) {
    $childCount = @($all | Where-Object { [int]$_.ParentProcessId -eq $listener }).Count
  }
  foreach ($process in $all) {
    $processId = [int]$process.ProcessId
    if (!$owned.Contains($processId)) { continue }
    if (!$process.ExecutablePath -or !$process.CreationDate) { $gpuOk = $false; continue }
    $worker = 'runtime-tree'
    if ($OllamaPort -gt 0) {
      $command = [string]$process.CommandLine
      $namedRunner = $command -match '(?i)(^|\s)runner(\s|$)'
      $isListener = $processId -eq $listener
      $isRunner = $namedRunner -or (-not $isListener) -or ($isListener -and $childCount -eq 0)
      $worker = if ($isRunner) { 'ollama-runner' } else { 'ollama-serve' }
    } elseif ($EngineRoot -and $process.ExecutablePath.StartsWith(($EngineRoot + '\'), [StringComparison]::OrdinalIgnoreCase)) {
      $requirement = $process.ExecutablePath.Substring($EngineRoot.Length + 1).Split('\')[0]
      if ($requirement -in @('text-recognition', 'speech-recognition', 'speaker-diarization')) { $worker = $requirement }
    }
    $attribution[$processId] = $worker
    $identity = [string]$processId + ':' + $process.CreationDate.ToUniversalTime().Ticks
    $identities[$processId] = $identity
    if ($null -ne $process.KernelModeTime -and $null -ne $process.UserModeTime) {
      $seconds = ([double]$process.KernelModeTime + [double]$process.UserModeTime) / 10000000
      $cpuSeconds += $seconds
      $lines += 'worker,' + $time + ',' + $identity + ',' + $worker + ',' + $seconds.ToString('0.0000000', [cultureinfo]::InvariantCulture)
    }
  }
  $sum = @{}
  foreach ($sample in $formatted) {
    if ($sample.Name -match '^pid_(\d+)_luid_0x([0-9a-f]{8})_0x([0-9a-f]{8})_phys_\d+_eng_\d+_engtype_(.+)$') {
      $scope = if ($owned.Contains([int]$Matches[1])) { 'owned' } else { 'other' }
      $worker = $attribution[[int]$Matches[1]]
      $key = $scope + ',' + ($Matches[2] + $Matches[3]).ToLowerInvariant() + ',' + $Matches[4] + ',' + $worker
      $sum[$key] = [double]$sum[$key] + $sample.UtilizationPercentage
    }
  }
  foreach ($sample in $raw) {
    if ($sample.Name -match '^pid_(\d+)_luid_0x([0-9a-f]{8})_0x([0-9a-f]{8})_phys_\d+_eng_(\d+)_engtype_(.+)$' -and $identities.ContainsKey([int]$Matches[1])) {
      $lines += 'busy,' + $time + ',' + $identities[[int]$Matches[1]] + ',' + ($Matches[2] + $Matches[3]).ToLowerInvariant() + ',' + $Matches[4] + ',' + $Matches[5] + ',' + $sample.RunningTime + ',' + $attribution[[int]$Matches[1]]
    }
  }
  foreach ($key in $sum.Keys) {
    $parts = $key.Split(',')
    if ($sum[$key] -gt 0) { $lines += 'gpu,' + $time + ',' + ($parts[0..2] -join ',') + ',' + $sum[$key].ToString([cultureinfo]::InvariantCulture) + ',' + $parts[3] }
  }
  $total = (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'").PercentProcessorTime
  $lines += 'cpu,' + $time + ',' + $cpuSeconds.ToString([cultureinfo]::InvariantCulture) + ',' + $total + ',' + $owned.Count + ',' + $gpuOk
  Add-Content -LiteralPath $Out -Value $lines -Encoding UTF8
  if ($NvidiaOut) {
    $nvidia = & nvidia-smi --query-gpu=timestamp,utilization.gpu,memory.used --format=csv,noheader,nounits
    if ($nvidia) { Add-Content -LiteralPath $NvidiaOut -Value $nvidia -Encoding UTF8 }
  }
  Start-Sleep -Seconds $IntervalSeconds
}
`;

const adapterListScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$rows = New-Object System.Collections.Generic.List[object]
$root = 'HKLM:\SOFTWARE\Microsoft\DirectX'
if (Test-Path -LiteralPath $root) {
  foreach ($item in @(Get-ChildItem -LiteralPath $root -ErrorAction Stop)) {
    $properties = Get-ItemProperty -LiteralPath $item.PSPath -ErrorAction SilentlyContinue
    if ($null -eq $properties -or $null -eq $properties.AdapterLuid -or [string]::IsNullOrWhiteSpace([string]$properties.Description)) { continue }
    $bytes = [uint64]0
    if ($null -ne $properties.DedicatedVideoMemory) { $bytes = [uint64]$properties.DedicatedVideoMemory }
    $vendor = [uint64]0
    if ($null -ne $properties.VendorId) { $vendor = [uint64]$properties.VendorId }
    [void]$rows.Add([pscustomobject]@{
      luidQword = ([uint64]$properties.AdapterLuid).ToString([cultureinfo]::InvariantCulture)
      dedicatedVideoBytes = $bytes.ToString([cultureinfo]::InvariantCulture)
      vendorId = $vendor.ToString([cultureinfo]::InvariantCulture)
      description = [string]$properties.Description
    })
  }
}
if ($rows.Count -eq 0) {
  '[]'
} else {
  $json = ConvertTo-Json -InputObject @($rows.ToArray()) -Compress
  if ($rows.Count -eq 1) { '[' + $json + ']' } else { $json }
}
`;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function powershellExe(): string {
  return `${process.env['SystemRoot'] ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

function nvidiaPresent(): boolean {
  const result = spawnSync('nvidia-smi', ['-L'], {
    windowsHide: true,
    stdio: 'ignore',
    timeout: SHORT_COMMAND_TIMEOUT_MS,
  });
  if (spawnTimedOut(result.error)) {
    throw new Error(`nvidia-smi -L timed out after ${SHORT_COMMAND_TIMEOUT_MS} ms.`);
  }
  return result.status === 0;
}

/** One Win32_Process CreationDate read, as UTC ticks. Null when the PID is already gone. */
export function readProcessCreationTicks(pid: number): string | null {
  if (!Number.isInteger(pid) || pid < 1) return null;
  const command = [
    '$utf8 = New-Object System.Text.UTF8Encoding $false',
    '[Console]::OutputEncoding = $utf8',
    '$OutputEncoding = $utf8',
    `$processRow = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -Property ProcessId, CreationDate`,
    'if ($null -eq $processRow -or $null -eq $processRow.CreationDate) { return }',
    'Write-Output ([string]$processRow.CreationDate.ToUniversalTime().Ticks)',
  ].join('; ');
  const result = spawnSync(
    powershellExe(),
    ['-NoProfile', '-NonInteractive', '-Command', command],
    { windowsHide: true, encoding: 'utf8', timeout: WINDOWS_SCRIPT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  if (spawnTimedOut(result.error)) {
    throw new Error(`Reading process creation time timed out after ${WINDOWS_SCRIPT_TIMEOUT_MS} ms.`);
  }
  const text = (result.stdout ?? '').replace(/^\uFEFF/u, '').replace(/\0/g, '').trim();
  if (!/^\d+$/u.test(text)) return null;
  return text;
}

export function taskkillTree(pid: number): void {
  if (!Number.isInteger(pid) || pid < 1) return;
  const result = spawnSync(
    `${process.env['SystemRoot'] ?? 'C:\\Windows'}\\System32\\taskkill.exe`,
    ['/PID', String(pid), '/T', '/F'],
    { windowsHide: true, stdio: 'ignore', timeout: SHORT_COMMAND_TIMEOUT_MS },
  );
  if (spawnTimedOut(result.error)) {
    throw new Error(`taskkill timed out after ${SHORT_COMMAND_TIMEOUT_MS} ms.`);
  }
}

/** Kill only when Node still tracks the child and the live PID is still that process. */
export function killIfRecordedProcess(child: ChildProcess, recordedCreation: string | null): void {
  const pid = child.pid;
  if (!pid || !recordedCreation || child.exitCode !== null || child.signalCode !== null) return;
  const liveCreation = readProcessCreationTicks(pid);
  if (!sameSpawnedProcess({ stillRunning: true, recordedCreation, liveCreation })) return;
  taskkillTree(pid);
}

export function parseRegistryAdapterJson(text: string): readonly RegistryAdapter[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end < start) return [];
  const parsed: unknown = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const luidQword = record['luidQword'];
    const dedicatedVideoBytes = record['dedicatedVideoBytes'];
    const vendorId = record['vendorId'];
    const description = record['description'];
    if (
      typeof luidQword !== 'string' ||
      typeof dedicatedVideoBytes !== 'string' ||
      typeof vendorId !== 'string' ||
      typeof description !== 'string'
    ) {
      return [];
    }
    return [{ luidQword, dedicatedVideoBytes, vendorId, description }];
  });
}

async function writeAdapterList(outFile: string): Promise<void> {
  const directory = dirname(outFile);
  await mkdir(directory, { recursive: true });
  const scriptPath = resolve(directory, 'list-adapters.ps1');
  await writeFile(scriptPath, adapterListScript, 'utf8');
  const result = spawnSync(powershellExe(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: WINDOWS_SCRIPT_TIMEOUT_MS,
  });
  if (spawnTimedOut(result.error)) {
    throw new Error(`list-adapters.ps1 timed out after ${WINDOWS_SCRIPT_TIMEOUT_MS} ms.`);
  }
  if (result.status !== 0 || !result.stdout?.trim()) {
    throw new Error('Could not read the GPU adapter list.');
  }
  const adapters = adaptersFromRegistry(parseRegistryAdapterJson(result.stdout));
  if (adapters.length === 0) throw new Error('No GPU adapters were listed.');
  await writeFile(outFile, `${JSON.stringify(adapters, null, 2)}\n`, 'utf8');
}

async function readAdapters(path: string): Promise<readonly GpuAdapter[]> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('The adapter list is not an array.');
  return parsed.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const luid = record['luid'];
    const adapterClass = record['adapterClass'];
    const description = record['description'];
    const vendorId = record['vendorId'];
    if (typeof luid !== 'string' || !/^[0-9a-f]{16}$/u.test(luid)) return [];
    if (adapterClass !== 'dedicated' && adapterClass !== 'integrated' && adapterClass !== 'software') return [];
    if (typeof description !== 'string') return [];
    if (vendorId !== null && typeof vendorId !== 'number') return [];
    return [{ luid, adapterClass, description, vendorId: vendorId ?? null }];
  });
}

async function observationFromDirectory(directory: string, adapters: readonly GpuAdapter[], worker: string | undefined): Promise<DeviceObservation> {
  const windows = parseWindowsSamples(await readFile(resolve(directory, 'windows-devices.csv'), 'utf8').catch(() => ''));
  const nvidia = parseNvidiaSamples(await readFile(resolve(directory, 'nvidia.csv'), 'utf8').catch(() => ''));
  return summarizeObservation({ ...windows, nvidia, adapters, ...(worker ? { worker } : {}) });
}

async function runSample(options: {
  readonly out: string;
  readonly rootPid?: number;
  readonly ollamaPort?: number;
  readonly engineRoot?: string;
}): Promise<void> {
  await mkdir(options.out, { recursive: true });
  const scriptPath = resolve(options.out, 'device-sampler.ps1');
  await writeFile(scriptPath, windowsSamplerScript, 'utf8');
  const csvPath = resolve(options.out, 'windows-devices.csv');
  const nvidiaPath = resolve(options.out, 'nvidia.csv');
  const useNvidia = nvidiaPresent();
  const child: ChildProcess = spawn(
    powershellExe(),
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      ...(options.rootPid ? ['-RootPid', String(options.rootPid)] : []),
      ...(options.ollamaPort ? ['-OllamaPort', String(options.ollamaPort)] : []),
      ...(options.engineRoot ? ['-EngineRoot', options.engineRoot] : []),
      '-Out',
      csvPath,
      ...(useNvidia ? ['-NvidiaOut', nvidiaPath] : []),
      '-IntervalSeconds',
      '2',
    ],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  child.once('error', () => undefined);
  let recordedCreation: string | null = null;
  const stopFile = resolve(options.out, 'stop');
  const startedFile = resolve(options.out, 'started');
  try {
    if (child.pid) recordedCreation = readProcessCreationTicks(child.pid);
    if (child.pid && recordedCreation === null && child.exitCode === null && child.signalCode === null) {
      throw new Error('The process creation time was not readable.');
    }
    const readyDeadline = Date.now() + 20_000;
    while (Date.now() < readyDeadline && !existsSync(startedFile)) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Device sampler exited before the first sample.');
      const windows = parseWindowsSamples(await readFile(csvPath, 'utf8').catch(() => ''));
      if (windows.cpu.length > 0) {
        await writeFile(startedFile, `${windows.cpu[0]?.time ?? ''}\n`, 'utf8');
        break;
      }
      await delay(250);
    }
    if (!existsSync(startedFile)) throw new Error('Device sampler produced no sample.');
    const stopDeadline = Date.now() + SAMPLE_STOP_TIMEOUT_MS;
    while (!existsSync(stopFile)) {
      if (Date.now() >= stopDeadline) {
        const message = `Device sampler timed out after ${SAMPLE_STOP_TIMEOUT_MS} ms before the phase wrote its stop file.`;
        await writeFile(resolve(options.out, 'timed-out'), `${message}\n`, 'utf8');
        throw new Error(message);
      }
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Device sampler exited before the phase ended.');
      await delay(250);
    }
    const stopTime = (await stat(stopFile)).mtimeMs;
    const afterDeadline = Date.now() + 15_000;
    while (Date.now() < afterDeadline) {
      const windows = parseWindowsSamples(await readFile(csvPath, 'utf8').catch(() => ''));
      if (windows.cpu.some((sample) => Date.parse(sample.time) >= stopTime)) break;
      await delay(250);
    }
  } finally {
    try {
      killIfRecordedProcess(child, recordedCreation);
    } finally {
      child.stderr?.destroy();
    }
  }
}

interface VerdictFlags {
  readonly samples: string;
  readonly adapters: string;
  readonly worker?: string;
  readonly device: string;
  readonly observed: ObservedDevice;
  readonly adapterClass?: 'dedicated' | 'integrated';
  readonly model?: string;
  readonly vendor?: 'nvidia';
  readonly server?: string;
  readonly verification?: string;
  readonly backend?: string;
  readonly mode?: string;
  readonly reportedDevice?: string;
  readonly reportedAdapter?: string;
  readonly reportedModel?: string;
  readonly reportedServer?: string;
  readonly reportedVerification?: string;
  readonly reportedBackend?: string;
  readonly reportedMode?: string;
}

async function printVerdict(flags: VerdictFlags): Promise<void> {
  const adapters = await readAdapters(flags.adapters);
  const observation = await observationFromDirectory(flags.samples, adapters, flags.worker);
  const decision = decidePhaseVerdict({
    design: {
      device: flags.device,
      observed: flags.observed,
      ...(flags.adapterClass ? { adapterClass: flags.adapterClass } : {}),
      ...(flags.model ? { model: flags.model } : {}),
      ...(flags.vendor ? { vendor: flags.vendor } : {}),
      ...(flags.server ? { server: flags.server } : {}),
      ...(flags.verification ? { verification: flags.verification } : {}),
      ...(flags.backend ? { backend: flags.backend } : {}),
      ...(flags.mode ? { mode: flags.mode } : {}),
    },
    reported: {
      ...(flags.reportedDevice !== undefined ? { device: flags.reportedDevice } : {}),
      ...(flags.reportedAdapter !== undefined ? { adapterClass: flags.reportedAdapter } : {}),
      ...(flags.reportedModel !== undefined ? { model: flags.reportedModel } : {}),
      ...(flags.reportedServer !== undefined ? { server: flags.reportedServer } : {}),
      ...(flags.reportedVerification !== undefined ? { verification: flags.reportedVerification } : {}),
      ...(flags.reportedBackend !== undefined ? { backend: flags.reportedBackend } : {}),
      ...(flags.reportedMode !== undefined ? { mode: flags.reportedMode } : {}),
    },
    observation,
  });
  process.stdout.write(`${JSON.stringify(decision)}\n`);
}

function positiveInteger(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || (label === 'port' && parsed > 65_535)) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function optionalEnum<T extends string>(value: string | undefined, allowed: readonly T[], label: string): T | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) throw new Error(`${label} is not one of ${allowed.join(', ')}.`);
  return value as T;
}

async function main(): Promise<void> {
  if (process.platform !== 'win32' && process.argv[2] !== 'verdict') {
    throw new Error('Device sampling runs on Windows only.');
  }
  const command = process.argv[2];
  const parsed = parseArgs({
    args: process.argv.slice(3),
    options: {
      out: { type: 'string' },
      samples: { type: 'string' },
      adapters: { type: 'string' },
      worker: { type: 'string' },
      'root-pid': { type: 'string' },
      'ollama-port': { type: 'string' },
      'engine-root': { type: 'string' },
      device: { type: 'string' },
      observed: { type: 'string' },
      'adapter-class': { type: 'string' },
      model: { type: 'string' },
      vendor: { type: 'string' },
      server: { type: 'string' },
      verification: { type: 'string' },
      backend: { type: 'string' },
      mode: { type: 'string' },
      'reported-device': { type: 'string' },
      'reported-adapter': { type: 'string' },
      'reported-model': { type: 'string' },
      'reported-server': { type: 'string' },
      'reported-verification': { type: 'string' },
      'reported-backend': { type: 'string' },
      'reported-mode': { type: 'string' },
    },
    allowPositionals: false,
  });
  if (command === 'adapters') {
    if (!parsed.values.out) throw new Error('adapters requires --out.');
    await writeAdapterList(resolve(parsed.values.out));
    return;
  }
  if (command === 'sample') {
    if (!parsed.values.out) throw new Error('sample requires --out.');
    const rootPid = parsed.values['root-pid'] ? positiveInteger(parsed.values['root-pid'], 'root pid') : undefined;
    const ollamaPort = parsed.values['ollama-port'] ? positiveInteger(parsed.values['ollama-port'], 'port') : undefined;
    if ((rootPid === undefined) === (ollamaPort === undefined)) {
      throw new Error('sample requires either --root-pid or --ollama-port.');
    }
    await runSample({
      out: resolve(parsed.values.out),
      ...(rootPid ? { rootPid } : {}),
      ...(ollamaPort ? { ollamaPort } : {}),
      ...(parsed.values['engine-root'] ? { engineRoot: resolve(parsed.values['engine-root']) } : {}),
    });
    return;
  }
  if (command === 'verdict') {
    if (!parsed.values.samples || !parsed.values.adapters || !parsed.values.device || !parsed.values.observed) {
      throw new Error('verdict requires --samples, --adapters, --device and --observed.');
    }
    const observed = optionalEnum(parsed.values.observed, ['dedicated-gpu', 'integrated-gpu', 'cpu'] as const, 'observed');
    if (!observed) throw new Error('observed device is required.');
    await printVerdict({
      samples: resolve(parsed.values.samples),
      adapters: resolve(parsed.values.adapters),
      ...(parsed.values.worker ? { worker: parsed.values.worker } : {}),
      device: parsed.values.device,
      observed,
      ...(optionalEnum(parsed.values['adapter-class'], ['dedicated', 'integrated'] as const, 'adapter class')
        ? { adapterClass: optionalEnum(parsed.values['adapter-class'], ['dedicated', 'integrated'] as const, 'adapter class') }
        : {}),
      ...(parsed.values.model ? { model: parsed.values.model } : {}),
      ...(optionalEnum(parsed.values.vendor, ['nvidia'] as const, 'vendor') ? { vendor: 'nvidia' as const } : {}),
      ...(parsed.values.server ? { server: parsed.values.server } : {}),
      ...(parsed.values.verification ? { verification: parsed.values.verification } : {}),
      ...(parsed.values.backend ? { backend: parsed.values.backend } : {}),
      ...(parsed.values.mode ? { mode: parsed.values.mode } : {}),
      ...(parsed.values['reported-device'] !== undefined ? { reportedDevice: parsed.values['reported-device'] } : {}),
      ...(parsed.values['reported-adapter'] !== undefined ? { reportedAdapter: parsed.values['reported-adapter'] } : {}),
      ...(parsed.values['reported-model'] !== undefined ? { reportedModel: parsed.values['reported-model'] } : {}),
      ...(parsed.values['reported-server'] !== undefined ? { reportedServer: parsed.values['reported-server'] } : {}),
      ...(parsed.values['reported-verification'] !== undefined
        ? { reportedVerification: parsed.values['reported-verification'] }
        : {}),
      ...(parsed.values['reported-backend'] !== undefined ? { reportedBackend: parsed.values['reported-backend'] } : {}),
      ...(parsed.values['reported-mode'] !== undefined ? { reportedMode: parsed.values['reported-mode'] } : {}),
    });
    return;
  }
  throw new Error('Use adapters, sample or verdict.');
}

function invokedDirectly(): boolean {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  return pathToFileURL(resolve(argvPath)).href.toLowerCase() === import.meta.url.toLowerCase();
}

if (invokedDirectly()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Device check failed.';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
