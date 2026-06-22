import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  normalizeForCommandLine,
  numberField,
  stringField,
  trimCapture,
} from './text-utils.mts';
import type {
  ProcessRecord,
  ProcessSnapshot,
  PublicProcessRecord,
  SelectNodeHelpersOptions,
} from './types.mts';

const PROCESS_SNAPSHOT_MAX_BUFFER = 64 * 1024 * 1024;
const WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS = 15_000;
const WINDOWS_CLOSE_REQUEST_TIMEOUT_MS = 5_000;
const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000;
const EXAM_PREP_PROCESS_NAMES = new Set([
  'exam-prep-desktop.exe',
  'exam-prep-backend.exe',
  'exam-prep-ocr-runtime.exe',
]);
const PROTECTED_NODE_COMMAND_FRAGMENTS = [
  'nx-mcp',
  'vscode',
  'visual studio code',
  'extensionhost',
  'code.exe',
  'servicehub',
];

type JsonProcessRow = {
  ProcessId?: unknown;
  ParentProcessId?: unknown;
  Name?: unknown;
  ExecutablePath?: unknown;
  CommandLine?: unknown;
};

/** Parses the PowerShell CIM process JSON shape used by Windows smoke cleanup. */
export function parseProcessSnapshotJson(stdout: string): ProcessRecord[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }
  const payload = JSON.parse(trimmed) as JsonProcessRow | JsonProcessRow[];
  const rows = Array.isArray(payload) ? payload : [payload];
  return rows
    .map((row) => ({
      pid: numberField(row.ProcessId),
      parentPid: numberField(row.ParentProcessId),
      name: stringField(row.Name),
      executablePath: stringField(row.ExecutablePath),
      commandLine: stringField(row.CommandLine),
    }))
    .filter((record) => record.pid > 0);
}

/** Captures the Windows process table needed for app and Node cleanup checks. */
export function snapshotWindowsProcesses(): ProcessRecord[] {
  if (process.platform !== 'win32') {
    return [];
  }

  const result = spawnSync(
    resolveWindowsPowerShellExecutable(),
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress",
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: PROCESS_SNAPSHOT_MAX_BUFFER,
      timeout: WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS,
    },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Process snapshot failed: ${trimCapture(result.stderr || result.stdout)}`,
    );
  }
  return parseProcessSnapshotJson(result.stdout);
}

/** Captures all processes plus the Node PID baseline for this verification run. */
export function processSnapshot(): ProcessSnapshot {
  const all = snapshotWindowsProcesses();
  return {
    all,
    nodePids: new Set(
      all
        .filter((record) => record.name.toLowerCase() === 'node.exe')
        .map((record) => record.pid),
    ),
  };
}

/** Resolves PowerShell even when packaged smoke runs with a reduced PATH. */
export function resolveWindowsPowerShellExecutable(
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = existsSync,
): string {
  const configured = env.EXAM_PREP_POWERSHELL_EXE?.trim();
  if (configured) {
    return configured;
  }

  const windowsRoot = env.SystemRoot?.trim() || env.WINDIR?.trim();
  if (windowsRoot) {
    const candidate = join(
      windowsRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    if (fileExists(candidate)) {
      return candidate;
    }
  }

  return 'powershell.exe';
}

/** Returns the root process and descendants from a flat process snapshot. */
export function collectProcessTree(
  processes: readonly ProcessRecord[],
  rootPid: number,
): ProcessRecord[] {
  const byParent = new Map<number, ProcessRecord[]>();
  for (const record of processes) {
    const children = byParent.get(record.parentPid) ?? [];
    children.push(record);
    byParent.set(record.parentPid, children);
  }

  const byPid = new Map(processes.map((record) => [record.pid, record]));
  const tree: ProcessRecord[] = [];
  const seen = new Set<number>();
  const queue = [rootPid];

  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid === undefined || seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    const record = byPid.get(pid);
    if (record) {
      tree.push(record);
    }
    for (const child of byParent.get(pid) ?? []) {
      queue.push(child.pid);
    }
  }

  return tree;
}

/** Identifies app/backend/OCR descendants that must not survive app close. */
export function isExamPrepResidue(record: ProcessRecord): boolean {
  const name = record.name.toLowerCase();
  const commandLine = record.commandLine.toLowerCase();
  return (
    EXAM_PREP_PROCESS_NAMES.has(name) ||
    commandLine.includes('--ocr-worker') ||
    commandLine.includes('exam-prep-ocr-runtime')
  );
}

/** Filters a launched app process tree down to exam-prep runtime residue. */
export function selectExamPrepResidue(
  processes: readonly ProcessRecord[],
  appPid: number,
): ProcessRecord[] {
  return collectProcessTree(processes, appPid).filter(isExamPrepResidue);
}

/** Selects only this-run workspace Node helpers while preserving global services. */
export function selectNewWorkspaceNodeHelpers({
  beforeNodePids,
  after,
  ownerPid,
  workspaceRoot,
  runMarker,
}: SelectNodeHelpersOptions): ProcessRecord[] {
  const ownerTreePids = new Set(
    collectProcessTree(after, ownerPid).map((record) => record.pid),
  );
  const workspaceNeedle = normalizeForCommandLine(workspaceRoot);
  const markerNeedle = normalizeForCommandLine(runMarker);

  return after.filter((record) => {
    if (record.name.toLowerCase() !== 'node.exe') {
      return false;
    }
    if (record.pid === ownerPid || beforeNodePids.has(record.pid)) {
      return false;
    }
    if (isProtectedNodeProcess(record)) {
      return false;
    }
    const commandLine = normalizeForCommandLine(record.commandLine);
    const isOwnedDescendant = ownerTreePids.has(record.pid);
    const isWorkspaceCommand = commandLine.includes(workspaceNeedle);
    const isRunMarked =
      commandLine.includes(markerNeedle) ||
      commandLine.includes('packaged-flow-smoke.mts');
    return isRunMarked || (isOwnedDescendant && isWorkspaceCommand);
  });
}

/** Builds the normal Windows close command used before forced termination. */
export function closeMainWindowPowerShellCommand(pid: number): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$process = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    'if ($null -eq $process) { exit 0 }',
    'if ($process.CloseMainWindow()) { exit 0 }',
    'exit 2',
  ].join('; ');
}

/** Requests a normal main-window close for the packaged app process. */
export function requestWindowsCloseByPid(pid: number): boolean {
  if (process.platform !== 'win32') {
    return false;
  }

  const result = spawnSync(
    resolveWindowsPowerShellExecutable(),
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      closeMainWindowPowerShellCommand(pid),
    ],
    {
      stdio: 'ignore',
      windowsHide: true,
      timeout: WINDOWS_CLOSE_REQUEST_TIMEOUT_MS,
    },
  );
  return !result.error && result.status === 0;
}

/** Force-terminates a process tree after graceful close has failed. */
export function terminateProcessTreeByPid(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: WINDOWS_TASKKILL_TIMEOUT_MS,
    });
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Process already exited.
    }
  }
}

/** Redacts a process record to the stable report shape. */
export function publicProcessRecord(record: ProcessRecord): PublicProcessRecord {
  return {
    pid: record.pid,
    parentPid: record.parentPid,
    name: record.name,
    commandLine: trimCapture(record.commandLine),
  };
}

function isProtectedNodeProcess(record: ProcessRecord): boolean {
  const commandLine = normalizeForCommandLine(record.commandLine);
  return PROTECTED_NODE_COMMAND_FRAGMENTS.some((fragment) =>
    commandLine.includes(fragment),
  );
}
