import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, createWriteStream, existsSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { resolveWindowsPowerShellExecutable } from './processes.mts';
import {
  dxgiAdapterProbeScript,
  windowsResourceSamplingScript,
} from './resource-sampling-scripts.mts';
import { finalizeResourceSamplingArtifacts } from './resource-sampling-summary.mts';
import type {
  ResourceSamplerStopResult,
  ResourceSamplerStopSummary,
  ResourceSamplingRun,
  StartResourceSamplingOptions,
} from './resource-sampling-types.mts';
import { errorMessage, normalizePath } from './text-utils.mts';
import type { ResourceSamplingArtifacts } from './types.mts';

const RESOURCE_SAMPLE_INTERVAL_MS = 1_000;
const WINDOWS_RESOURCE_SCRIPT_NAME = 'windows-resource-sampling.ps1';
const RESOURCE_SAMPLER_GRACE_MS = 5_000;
const RESOURCE_SAMPLER_FORCE_MS = 5_000;

interface XrtSmiResult {
  readonly command: readonly string[];
  readonly exit_code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: string | null;
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
  writeXrtSmiSummary({ outDir, workspaceRoot, artifacts, observe });

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

function writeXrtSmiSummary({
  outDir,
  workspaceRoot,
  artifacts,
  observe,
}: {
  readonly outDir: string;
  readonly workspaceRoot: string;
  readonly artifacts: ResourceSamplingArtifacts;
  readonly observe: (message: string) => void;
}): void {
  const executable = resolveXrtSmiExecutable();
  const summaryPath = join(outDir, 'xrt-smi-summary.json');
  if (!executable) {
    writeFileSync(
      summaryPath,
      `${JSON.stringify(
        {
          available: false,
          executable: null,
          npu_detected: false,
          power_watts_available: false,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    artifacts.xrt_smi_summary_json = normalizePath(relative(workspaceRoot, summaryPath));
    observe('xrt-smi unavailable; NPU power telemetry will be marked unavailable.');
    return;
  }
  const version = runXrtSmi([executable, '--version'], workspaceRoot);
  const examine = runXrtSmi([executable, 'examine', '--batch'], workspaceRoot);
  const text = `${version.stdout}\n${examine.stdout}`;
  writeFileSync(
    summaryPath,
    `${JSON.stringify(
      {
        available: true,
        executable,
        version,
        examine_batch: examine,
        npu_detected: text.toUpperCase().includes('NPU'),
        power_watts_available: text.includes(' W') || text.includes('Watts'),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  artifacts.xrt_smi_summary_json = normalizePath(relative(workspaceRoot, summaryPath));
}

function resolveXrtSmiExecutable(): string | null {
  const candidates = [
    process.env.EXAM_PREP_XRT_SMI_EXE,
    'C:/Windows/System32/AMD/xrt-smi.exe',
    'C:/Program Files/AMD/XRT/bin/xrt-smi.exe',
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  const result = spawnSync('where.exe', ['xrt-smi.exe'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.split(/\r?\n/).find(Boolean) ?? null : null;
}

function runXrtSmi(
  command: readonly string[],
  workspaceRoot: string,
): XrtSmiResult {
  const result = spawnSync(command[0], command.slice(1), {
    cwd: workspaceRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000,
  });
  return {
    command,
    exit_code: result.status,
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? '').trim(),
    error: result.error?.message ?? null,
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
