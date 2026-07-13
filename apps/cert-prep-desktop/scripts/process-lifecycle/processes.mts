import { execFile, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const PROCESS_SNAPSHOT_MAX_BUFFER = 64 * 1024 * 1024;
const WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS = 15_000;
const WINDOWS_CLOSE_REQUEST_TIMEOUT_MS = 5_000;
const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000;
const CAPTURE_LIMIT = 12_000;
const CERT_PREP_PROCESS_NAMES = new Set([
  'cert-prep-desktop.exe',
  'cert-prep-backend.exe',
  'cert-prep-ocr-runtime.exe',
]);
const PROTECTED_COMMAND_FRAGMENTS = [
  'nx-mcp',
  '/.mcp/agy-codex/server.py',
  '/.mcp/',
  '/.codex/',
  '/codex',
  'codex',
  '/.claude/',
  'claude',
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
  CreationDate?: unknown;
  WorkingSetSize?: unknown;
};

export interface ProcessRecord {
  pid: number;
  parentPid: number;
  name: string;
  executablePath: string;
  commandLine: string;
  creationDate: string;
  workingSetBytes: number | null;
}

export interface PublicProcessRecord {
  pid: number;
  parentPid: number;
  name: string;
  commandLine: string;
}

export interface ProcessSnapshot {
  all: ProcessRecord[];
  nodePids: Set<number>;
}

interface SelectNodeHelpersOptions {
  beforeNodePids: ReadonlySet<number>;
  after: readonly ProcessRecord[];
  ownerPid: number;
  workspaceRoot: string;
  runMarker: string;
}

export type ProcessClassification =
  | 'cert_prep_residue'
  | 'workspace_node_helper'
  | 'workspace_python_runtime'
  | 'tooling_resident'
  | 'workspace_tooling_review'
  | 'unknown';

export type RecommendedProcessAction =
  | 'manual_cleanup_candidate'
  | 'investigate_owner'
  | 'protected_do_not_touch'
  | 'review_only'
  | 'manual_investigation';

interface ProcessClassificationResult {
  classification: ProcessClassification;
  recommendedAction: RecommendedProcessAction;
  protected: boolean;
  evidence: string[];
}

interface ProcessClassificationOptions {
  workspaceRoot: string;
}

interface ProcessTerminationResult {
  attempted: boolean;
  method: 'taskkill_process_tree' | 'signal_process' | 'already_exited';
  exitCode: number | null;
  error: string | null;
}

interface OwnedProcessCleanupResult {
  label: string;
  pid: number | null;
  reason: string;
  attempted: boolean;
  method: ProcessTerminationResult['method'];
  alreadyExited: boolean;
  forced: boolean;
  stopped: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error: string | null;
}

interface ShutdownCleanupOptions {
  cleanup: (reason: string, error: unknown | null) => Promise<void> | void;
  exit?: (code?: number) => never | void;
  onCleanupError?: (error: unknown) => void;
}

type ShutdownHandler = (
  reason: string,
  error: unknown | null,
  exitCode: number,
) => Promise<void>;

const DEFAULT_TRACKED_PROCESS_WAIT_MS = 5_000;

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
      creationDate: stringField(row.CreationDate),
      workingSetBytes: nullableNumberField(row.WorkingSetSize),
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
    windowsProcessSnapshotArguments(),
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

/** Captures the same process table without blocking Playwright's event loop. */
export async function snapshotWindowsProcessesAsync(): Promise<ProcessRecord[]> {
  if (process.platform !== 'win32') {
    return [];
  }

  return await new Promise<ProcessRecord[]>((resolve, reject) => {
    execFile(
      resolveWindowsPowerShellExecutable(),
      windowsProcessSnapshotArguments(),
      {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: PROCESS_SNAPSHOT_MAX_BUFFER,
        timeout: WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `Process snapshot failed: ${trimCapture(stderr || error.message)}`,
            ),
          );
          return;
        }
        try {
          resolve(parseProcessSnapshotJson(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}

function windowsProcessSnapshotArguments(): string[] {
  return [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate,WorkingSetSize | ConvertTo-Json -Compress",
  ];
}

/** Captures all processes plus the Node PID baseline for this verification run. */
export function processSnapshot(): ProcessSnapshot {
  const all = snapshotWindowsProcesses();
  return {
    all,
    nodePids: new Set(
      all
        .filter((record) => isNodeProcessName(record.name.toLowerCase()))
        .map((record) => record.pid),
    ),
  };
}

/** Resolves PowerShell even when packaged smoke runs with a reduced PATH. */
export function resolveWindowsPowerShellExecutable(
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = existsSync,
): string {
  const configured = env.CERT_PREP_POWERSHELL_EXE?.trim();
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
export function isCertPrepResidue(record: ProcessRecord): boolean {
  const name = record.name.toLowerCase();
  const commandLine = record.commandLine.toLowerCase();
  return (
    CERT_PREP_PROCESS_NAMES.has(name) ||
    commandLine.includes('--ocr-worker') ||
    commandLine.includes('cert-prep-ocr-runtime')
  );
}

/** Classifies a process for read-only residue audit reporting. */
export function classifyProcessForAudit(
  record: ProcessRecord,
  { workspaceRoot }: ProcessClassificationOptions,
): ProcessClassificationResult {
  const name = record.name.toLowerCase();
  const commandLine = normalizeForCommandLine(record.commandLine);
  const executablePath = normalizeForCommandLine(record.executablePath);
  const workspaceNeedle = normalizeForCommandLine(workspaceRoot);
  const evidence: string[] = [];

  const protectedFragment = PROTECTED_COMMAND_FRAGMENTS.find((fragment) =>
    commandLine.includes(fragment),
  );
  if (protectedFragment) {
    return {
      classification: 'tooling_resident',
      recommendedAction: 'protected_do_not_touch',
      protected: true,
      evidence: [`matched protected command fragment: ${protectedFragment}`],
    };
  }

  if (isCertPrepResidue(record)) {
    return {
      classification: 'cert_prep_residue',
      recommendedAction: 'manual_cleanup_candidate',
      protected: false,
      evidence: ['matched cert-prep runtime residue marker'],
    };
  }

  const isWorkspaceProcess =
    Boolean(workspaceNeedle) &&
    (commandLine.includes(workspaceNeedle) || executablePath.includes(workspaceNeedle));
  if (isWorkspaceProcess) {
    evidence.push('matched workspace root');
  }

  if (isNodeProcessName(name)) {
    if (isWorkspaceToolingReviewCommand(commandLine)) {
      return {
        classification: 'workspace_tooling_review',
        recommendedAction: 'review_only',
        protected: false,
        evidence: [...evidence, 'matched Nx/Playwright resident tooling marker'],
      };
    }
    if (isWorkspaceProcess) {
      return {
        classification: 'workspace_node_helper',
        recommendedAction: 'investigate_owner',
        protected: false,
        evidence,
      };
    }
  }

  if (isPythonProcessName(name) && isWorkspaceProcess) {
    return {
      classification: 'workspace_python_runtime',
      recommendedAction: 'investigate_owner',
      protected: false,
      evidence,
    };
  }

  return {
    classification: 'unknown',
    recommendedAction: 'manual_investigation',
    protected: false,
    evidence,
  };
}

/** Filters a launched app process tree down to cert-prep runtime residue. */
export function selectCertPrepResidue(
  processes: readonly ProcessRecord[],
  appPid: number,
): ProcessRecord[] {
  return collectProcessTree(processes, appPid).filter(isCertPrepResidue);
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
    if (!isNodeProcessName(record.name.toLowerCase())) {
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

/** Tracks child processes owned by this script invocation for scoped cleanup. */
export class OwnedProcessTracker {
  private readonly processes = new Map<number, { label: string; child: ChildProcess }>();
  private cleanupPromise: Promise<OwnedProcessCleanupResult[]> | null = null;
  private cleanupResults: OwnedProcessCleanupResult[] | null = null;

  registerChild(label: string, child: ChildProcess): void {
    if (child.pid === undefined) {
      return;
    }
    this.processes.set(child.pid, { label, child });
  }

  async cleanup(reason: string): Promise<OwnedProcessCleanupResult[]> {
    if (this.cleanupResults) {
      return this.cleanupResults;
    }
    if (this.cleanupPromise) {
      return this.cleanupPromise;
    }

    this.cleanupPromise = Promise.all(
      [...this.processes.values()].map(({ label, child }) =>
        cleanupTrackedChild(label, child, reason),
      ),
    ).then((results) => {
      this.cleanupResults = results;
      return results;
    });
    return this.cleanupPromise;
  }

  cleanupSync(reason: string): OwnedProcessCleanupResult[] {
    if (this.cleanupResults) {
      return this.cleanupResults;
    }
    const results = [...this.processes.values()].map(({ label, child }) =>
      cleanupTrackedChildSync(label, child, reason),
    );
    this.cleanupResults = results;
    return results;
  }
}

/** Creates a reusable shutdown handler whose cleanup can only run once. */
export function createShutdownCleanupHandler({
  cleanup,
  exit = process.exit,
  onCleanupError = (error) => console.error(error),
}: ShutdownCleanupOptions): ShutdownHandler {
  let cleanupStarted = false;
  return async (reason, error, exitCode) => {
    if (cleanupStarted) {
      return;
    }
    cleanupStarted = true;
    try {
      await cleanup(reason, error);
    } catch (cleanupError) {
      onCleanupError(cleanupError);
    }
    if (error) {
      console.error(error);
    }
    process.exitCode = exitCode;
    exit(exitCode);
  };
}

/** Installs scoped process cleanup for interrupts and fatal Node errors. */
export function installProcessShutdownCleanup(
  options: ShutdownCleanupOptions,
): () => void {
  const handler = createShutdownCleanupHandler(options);
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  for (const [signal, exitCode] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ] as const) {
    const listener = () => {
      void handler(signal, null, exitCode);
    };
    process.once(signal, listener);
    signalHandlers.set(signal, listener);
  }

  const uncaughtException = (error: Error) => {
    void handler('uncaughtException', error, 1);
  };
  const unhandledRejection = (reason: unknown) => {
    void handler('unhandledRejection', reason, 1);
  };
  process.once('uncaughtException', uncaughtException);
  process.once('unhandledRejection', unhandledRejection);

  return () => {
    for (const [signal, listener] of signalHandlers) {
      process.off(signal, listener);
    }
    process.off('uncaughtException', uncaughtException);
    process.off('unhandledRejection', unhandledRejection);
  };
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
export function terminateProcessTreeByPid(pid: number): ProcessTerminationResult {
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: WINDOWS_TASKKILL_TIMEOUT_MS,
    });
    return {
      attempted: true,
      method: 'taskkill_process_tree',
      exitCode: result.status ?? null,
      error:
        result.error?.message ??
        (result.status === 0 || result.status === null
          ? null
          : `taskkill exited ${result.status}`),
    };
  } else {
    try {
      process.kill(pid, 'SIGTERM');
      return {
        attempted: true,
        method: 'signal_process',
        exitCode: null,
        error: null,
      };
    } catch {
      return {
        attempted: false,
        method: 'already_exited',
        exitCode: null,
        error: null,
      };
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
  return PROTECTED_COMMAND_FRAGMENTS.some((fragment) =>
    commandLine.includes(fragment),
  );
}

/** Coerces process/API numeric fields into finite report-safe numbers. */
function numberField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : Number(value) || 0;
}

function nullableNumberField(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = numberField(value);
  return parsed > 0 ? parsed : null;
}

/** Coerces optional process/API fields into report-safe strings. */
function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Normalizes Windows and POSIX separators for report paths and matching. */
function normalizePath(path: string): string {
  return path.split(/[\\/]+/).join('/');
}

/** Normalizes a command line fragment for case-insensitive Windows matching. */
function normalizeForCommandLine(value: string): string {
  return normalizePath(value).toLowerCase();
}

/** Keeps captured output bounded before it enters reports or errors. */
function trimCapture(value: string): string {
  return value.trim().slice(-CAPTURE_LIMIT);
}

function isNodeProcessName(name: string): boolean {
  return name === 'node.exe' || name === 'node';
}

function isPythonProcessName(name: string): boolean {
  return name === 'python.exe' || name === 'pythonw.exe' || name === 'python';
}

function isWorkspaceToolingReviewCommand(commandLine: string): boolean {
  return (
    commandLine.includes('test-server') ||
    commandLine.includes('playwright') ||
    commandLine.includes('/nx/dist/bin/nx.js') ||
    commandLine.includes('/node_modules/.bin/../nx/') ||
    commandLine.includes('/.nx/') ||
    (commandLine.includes('nx') && commandLine.includes('daemon'))
  );
}

async function cleanupTrackedChild(
  label: string,
  child: ChildProcess,
  reason: string,
): Promise<OwnedProcessCleanupResult> {
  const initial = cleanupTrackedChildSync(label, child, reason);
  if (initial.alreadyExited || child.pid === undefined) {
    return initial;
  }
  const stopped = await waitForTrackedChildExit(child, DEFAULT_TRACKED_PROCESS_WAIT_MS);
  return {
    ...initial,
    stopped,
    exitCode: child.exitCode,
    signal: child.signalCode,
    error: stopped ? initial.error : initial.error ?? 'process did not exit after cleanup',
  };
}

function cleanupTrackedChildSync(
  label: string,
  child: ChildProcess,
  reason: string,
): OwnedProcessCleanupResult {
  const pid = child.pid ?? null;
  const alreadyExited = child.exitCode !== null || child.signalCode !== null;
  if (alreadyExited || pid === null) {
    return {
      label,
      pid,
      reason,
      attempted: false,
      method: 'already_exited',
      alreadyExited,
      forced: false,
      stopped: alreadyExited,
      exitCode: child.exitCode,
      signal: child.signalCode,
      error: null,
    };
  }

  const termination = terminateProcessTreeByPid(pid);
  return {
    label,
    pid,
    reason,
    attempted: termination.attempted,
    method: termination.method,
    alreadyExited: false,
    forced: termination.attempted,
    stopped: false,
    exitCode: child.exitCode ?? termination.exitCode,
    signal: child.signalCode,
    error: termination.error,
  };
}

async function waitForTrackedChildExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
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
