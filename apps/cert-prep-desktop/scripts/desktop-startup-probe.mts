import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { chromium, type BrowserContext, type Page } from 'playwright';

import {
  collectProcessTree,
  requestWindowsCloseByPid,
  snapshotWindowsProcesses,
  terminateProcessTreeByPid,
} from './process-lifecycle/processes.mts';
import type { ProcessRecord } from './process-lifecycle/processes.mts';

export const DESKTOP_STACK_RESERVE_BYTES = 8 * 1024 * 1024;
export const STARTUP_PROBE_PHASES = [
  'no-cdp',
  'cdp-attach',
  'cdp-viewport',
] as const;

export type StartupProbePhase = (typeof STARTUP_PROBE_PHASES)[number];

type ProbePhaseSelection = StartupProbePhase | 'all';
type ProbeReachedPhase =
  | 'spawned'
  | 'no-cdp-stable'
  | 'cdp-endpoint-ready'
  | 'cdp-attached'
  | 'viewport-set'
  | 'capture-trial-loaded';

export interface DesktopStartupFailureInput {
  readonly phase: StartupProbePhase;
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly error: string | null;
}

export type DesktopStartupFailure =
  | {
      readonly kind: 'stack-overflow';
      readonly phase: StartupProbePhase;
      readonly secondaryError: string | null;
    }
  | {
      readonly kind: 'process-exit';
      readonly phase: StartupProbePhase;
      readonly exitCode: number | null;
      readonly secondaryError: string | null;
    }
  | {
      readonly kind: 'phase-error';
      readonly phase: StartupProbePhase;
      readonly error: string;
    }
  | null;

export function classifyDesktopStartupFailure({
  phase,
  exitCode,
  stderr,
  error,
}: DesktopStartupFailureInput): DesktopStartupFailure {
  if (
    exitCode === 0xc00000fd ||
    /thread 'main'.*has overflowed its stack/i.test(stderr)
  ) {
    return {
      kind: 'stack-overflow',
      phase,
      secondaryError: error,
    };
  }
  if (exitCode !== null) {
    return {
      kind: 'process-exit',
      phase,
      exitCode,
      secondaryError: error,
    };
  }
  return error ? { kind: 'phase-error', phase, error } : null;
}

/** Reads the PE optional-header SizeOfStackReserve field without executing the binary. */
export function parsePeStackReserve(buffer: Uint8Array): number {
  const bytes = Buffer.from(buffer);
  if (bytes.length < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) {
    throw new Error('PE parser expected an MZ header.');
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  const optionalHeaderOffset = peOffset + 24;
  if (
    peOffset > bytes.length - 24 ||
    bytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0' ||
    optionalHeaderOffset > bytes.length - 2
  ) {
    throw new Error('PE parser expected a complete PE header.');
  }
  const magic = bytes.readUInt16LE(optionalHeaderOffset);
  const stackReserveOffset = optionalHeaderOffset + 72;
  if (magic === 0x10b) {
    if (stackReserveOffset > bytes.length - 4) {
      throw new Error('PE32 header is missing SizeOfStackReserve.');
    }
    return bytes.readUInt32LE(stackReserveOffset);
  }
  if (magic === 0x20b) {
    if (stackReserveOffset > bytes.length - 8) {
      throw new Error('PE32+ header is missing SizeOfStackReserve.');
    }
    const reserve = bytes.readBigUInt64LE(stackReserveOffset);
    if (reserve > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('PE32+ SizeOfStackReserve exceeds JavaScript safe integer range.');
    }
    return Number(reserve);
  }
  throw new Error(`Unsupported PE optional-header magic: 0x${magic.toString(16)}.`);
}

export function readPeStackReserve(executablePath: string): number {
  return parsePeStackReserve(readFileSync(executablePath));
}

/** Keeps environment evidence useful while preventing secret values from entering artifacts. */
export function redactProbeEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => [
        name,
        isSensitiveEnvironmentName(name) ? '[REDACTED]' : value,
      ]),
  );
}

interface ProbeOptions {
  readonly workspaceRoot: string;
  readonly exePath: string;
  readonly outDir: string;
  readonly appDataDir: string;
  readonly cdpPort: number;
  readonly coldStarts: number;
  readonly phaseSelection: ProbePhaseSelection;
  readonly verifyCaptureTrial: boolean;
}

type MutableProbeOptions = {
  -readonly [Key in keyof ProbeOptions]: ProbeOptions[Key];
};

interface FileIdentity {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface ProcessEvidence {
  readonly pid: number;
  readonly parent_pid: number;
  readonly name: string;
  readonly image_path: string;
}

interface ProbeCloseout {
  readonly normal_close_requested: boolean;
  readonly exited_after_normal_close: boolean;
  readonly forced_tree_termination: boolean;
  readonly exit_code: number | null;
  readonly residue: ProcessEvidence[];
}

interface ProbePhaseReport {
  readonly cold_start: number;
  readonly phase: StartupProbePhase;
  readonly cdp_port: number | null;
  readonly app_data_dir: string;
  readonly reached: ProbeReachedPhase;
  readonly started_at: string;
  readonly finished_at: string;
  readonly exit_code_before_close: number | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly failure: DesktopStartupFailure;
  readonly owned_processes_before_close: ProcessEvidence[];
  readonly closeout: ProbeCloseout;
}

interface ProbeReport {
  readonly schema_version: 1;
  readonly status: 'completed' | 'failed';
  readonly started_at: string;
  readonly finished_at: string;
  readonly executable: FileIdentity;
  readonly pe_stack_reserve_bytes: number;
  readonly resources: FileIdentity[];
  readonly environment: Record<string, string>;
  readonly phase_order: readonly StartupProbePhase[];
  readonly runs: ProbePhaseReport[];
}

type MutableProbeReport = {
  -readonly [Key in keyof ProbeReport]: ProbeReport[Key];
};

interface RunningApp {
  readonly child: ChildProcess;
  stdout: string;
  stderr: string;
}

const DEFAULT_CDP_PORT = 9611;
const DEFAULT_STARTUP_STABILITY_MS = 3_000;
const DEFAULT_CDP_TIMEOUT_MS = 20_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 8_000;
const SENSITIVE_TEXT_PATTERNS = [
  /(Bearer\s+)[^\s"']+/gi,
  /((?:token|secret|password|authorization)\s*[=:]\s*)[^\s"']+/gi,
] as const;

export function parseDesktopStartupProbeArgs(
  argv: readonly string[],
  workspaceRoot = defaultWorkspaceRoot(),
): ProbeOptions {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const parsed: MutableProbeOptions = {
    workspaceRoot,
    exePath: resolve(
      workspaceRoot,
      'apps/cert-prep-desktop/src-tauri/target/x86_64-pc-windows-msvc/release/cert-prep-desktop.exe',
    ),
    outDir: resolve(
      workspaceRoot,
      'tmp/cert-prep-desktop/desktop-startup-probe',
      timestamp,
    ),
    appDataDir: '',
    cdpPort: DEFAULT_CDP_PORT,
    coldStarts: 1,
    phaseSelection: 'all',
    verifyCaptureTrial: false,
  };
  let appDataDirExplicit = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const nextValue = (): string => {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${argument} requires a value.`);
      }
      index += 1;
      return value;
    };

    if (argument === '--exe') {
      parsed.exePath = resolve(workspaceRoot, nextValue());
    } else if (argument === '--out-dir') {
      parsed.outDir = resolve(workspaceRoot, nextValue());
    } else if (argument === '--app-data-dir') {
      parsed.appDataDir = resolve(workspaceRoot, nextValue());
      appDataDirExplicit = true;
    } else if (argument === '--cdp-port') {
      parsed.cdpPort = positiveInteger(Number(nextValue()), argument);
    } else if (argument === '--cold-starts') {
      parsed.coldStarts = positiveInteger(Number(nextValue()), argument);
    } else if (argument === '--phase') {
      parsed.phaseSelection = parsePhaseSelection(nextValue());
    } else if (argument === '--verify-capture-trial') {
      parsed.verifyCaptureTrial = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!appDataDirExplicit) {
    parsed.appDataDir = join(parsed.outDir, 'app-data');
  }
  if (parsed.verifyCaptureTrial && parsed.phaseSelection !== 'cdp-viewport') {
    throw new Error('--verify-capture-trial requires --phase cdp-viewport.');
  }
  assertFreshProbeDirectories(parsed);
  return parsed;
}

export async function runDesktopStartupProbe(
  options: ProbeOptions,
): Promise<ProbeReport> {
  if (!existsSync(options.exePath)) {
    throw new Error(`Missing desktop executable: ${options.exePath}`);
  }
  mkdirSync(options.outDir, { recursive: false });
  mkdirSync(options.appDataDir, { recursive: false });

  const startedAt = new Date().toISOString();
  const environment = buildProbeEnvironment(options);
  const report: MutableProbeReport = {
    schema_version: 1,
    status: 'completed',
    started_at: startedAt,
    finished_at: startedAt,
    executable: fileIdentity(options.exePath),
    pe_stack_reserve_bytes: readPeStackReserve(options.exePath),
    resources: collectResourceIdentities(options.exePath),
    environment: probeEnvironmentEvidence(environment),
    phase_order: STARTUP_PROBE_PHASES,
    runs: [],
  };

  try {
    const phases = selectedPhases(options.phaseSelection);
    for (let coldStart = 1; coldStart <= options.coldStarts; coldStart += 1) {
      for (const phase of phases) {
        const phasePort =
          phase === 'no-cdp'
            ? null
            : options.cdpPort + (coldStart - 1) * 10 + phases.indexOf(phase);
        const phaseReport = await runProbePhase({
          options,
          phase,
          coldStart,
          cdpPort: phasePort,
        });
        report.runs.push(phaseReport);
        report.status = report.runs.some((run) => run.failure !== null)
          ? 'failed'
          : 'completed';
        writeProbeReport(options.outDir, report);
      }
    }
  } finally {
    report.finished_at = new Date().toISOString();
    report.status = report.runs.some((run) => run.failure !== null)
      ? 'failed'
      : 'completed';
    writeProbeReport(options.outDir, report);
  }
  return report;
}

export async function runDesktopStartupProbeCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const report = await runDesktopStartupProbe(parseDesktopStartupProbeArgs(argv));
  console.log(
    JSON.stringify(
      {
        status: report.status,
        out_dir: report.runs.length > 0 ? dirname(report.runs[0].app_data_dir) : null,
        report: 'startup-probe.json',
        pe_stack_reserve_bytes: report.pe_stack_reserve_bytes,
      },
      null,
      2,
    ),
  );
  if (report.status !== 'completed') {
    process.exitCode = 1;
  }
}

async function runProbePhase({
  options,
  phase,
  coldStart,
  cdpPort,
}: {
  readonly options: ProbeOptions;
  readonly phase: StartupProbePhase;
  readonly coldStart: number;
  readonly cdpPort: number | null;
}): Promise<ProbePhaseReport> {
  const startedAt = new Date().toISOString();
  const runRoot = join(options.outDir, `cold-${coldStart}`, phase);
  const appDataDir = join(options.appDataDir, `cold-${coldStart}`, phase);
  mkdirSync(runRoot, { recursive: true });
  mkdirSync(appDataDir, { recursive: true });

  let reached: ProbeReachedPhase = 'spawned';
  let phaseError: string | null = null;
  const app = launchProbeApp({
    options,
    appDataDir,
    runRoot,
    cdpPort,
  });
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
  let ownedBeforeClose: ProcessRecord[] = [];
  try {
    if (phase === 'no-cdp') {
      await delay(DEFAULT_STARTUP_STABILITY_MS);
      throwIfExited(app.child, phase);
      reached = 'no-cdp-stable';
    } else {
      if (cdpPort === null) {
        throw new Error(`${phase} requires a CDP port.`);
      }
      await waitForCdpEndpoint(cdpPort, app.child, DEFAULT_CDP_TIMEOUT_MS);
      reached = 'cdp-endpoint-ready';
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const initialPage =
        context.pages()[0] ??
        (await context.waitForEvent('page', { timeout: 30_000 }));
      reached = 'cdp-attached';
      if (phase === 'cdp-viewport') {
        const page = options.verifyCaptureTrial
          ? await waitForApplicationPage(context, initialPage)
          : initialPage;
        await page.setViewportSize({ width: 1440, height: 1000 });
        reached = 'viewport-set';
        if (options.verifyCaptureTrial) {
          await page.goto(captureTrialUrl(page.url()), {
            waitUntil: 'commit',
            timeout: 10_000,
          });
          await page
            .getByRole('heading', { name: 'Capture Workbench trial' })
            .waitFor({ state: 'visible', timeout: 60_000 });
          reached = 'capture-trial-loaded';
        }
      }
      await delay(750);
      throwIfExited(app.child, phase);
    }
  } catch (error) {
    phaseError = errorMessage(error);
  } finally {
    try {
      ownedBeforeClose = app.child.pid
        ? collectProcessTree(snapshotWindowsProcesses(), app.child.pid)
        : [];
    } catch (processError) {
      phaseError ??= `process evidence failed: ${errorMessage(processError)}`;
    }
  }

  const exitCodeBeforeClose = app.child.exitCode;
  const closeout = await closeProbeApp(app.child, ownedBeforeClose);
  await closeBrowserWithTimeout(browser).catch((browserCloseError) => {
    phaseError ??= `browser close failed: ${errorMessage(browserCloseError)}`;
  });
  const stderr = redactSensitiveText(app.stderr);
  const stdout = redactSensitiveText(app.stdout);
  writeFileSync(join(runRoot, 'app.stderr.log'), stderr);
  writeFileSync(join(runRoot, 'app.stdout.log'), stdout);
  return {
    cold_start: coldStart,
    phase,
    cdp_port: cdpPort,
    app_data_dir: appDataDir,
    reached,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    exit_code_before_close: exitCodeBeforeClose,
    stderr,
    stdout,
    failure: classifyDesktopStartupFailure({
      phase,
      exitCode: exitCodeBeforeClose,
      stderr: app.stderr,
      error: phaseError,
    }),
    owned_processes_before_close: ownedBeforeClose.map(processEvidence),
    closeout,
  };
}

function launchProbeApp({
  options,
  appDataDir,
  runRoot,
  cdpPort,
}: {
  readonly options: ProbeOptions;
  readonly appDataDir: string;
  readonly runRoot: string;
  readonly cdpPort: number | null;
}): RunningApp {
  const child = spawn(options.exePath, [], {
    cwd: options.workspaceRoot,
    env: buildProbeEnvironment(options, appDataDir, runRoot, cdpPort),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const app: RunningApp = { child, stdout: '', stderr: '' };
  child.stdout?.on('data', (chunk) => {
    app.stdout += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    app.stderr += String(chunk);
  });
  return app;
}

function buildProbeEnvironment(
  options: ProbeOptions,
  appDataDir = options.appDataDir,
  logDir = options.outDir,
  cdpPort: number | null = null,
  inherited: Readonly<NodeJS.ProcessEnv> = process.env,
): NodeJS.ProcessEnv {
  const inheritedWithoutDesktopSettings = Object.fromEntries(
    Object.entries(inherited).filter(([name, value]) => {
      if (value === undefined) {
        return false;
      }
      const normalized = name.toLowerCase();
      return !(
        normalized.startsWith('cert_prep_') ||
        normalized.startsWith('ollama_') ||
        normalized.startsWith('webview2_') ||
        normalized.startsWith('capture_runtime_') ||
        normalized === 'no_proxy'
      );
    }),
  );
  return {
    ...inheritedWithoutDesktopSettings,
    NO_PROXY: 'localhost,127.0.0.1,::1',
    WEBVIEW2_USER_DATA_FOLDER: join(appDataDir, 'webview2'),
    ...(cdpPort === null
      ? {}
      : {
          WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
        }),
    CERT_PREP_DESKTOP_DATA_DIR: appDataDir,
    CERT_PREP_BACKEND_LOG_DIR: logDir,
    CERT_PREP_BACKEND_READY_TIMEOUT_SECS: '90',
    CERT_PREP_LLM_PROVIDER: 'fake',
  };
}

async function waitForCdpEndpoint(
  port: number,
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const endpoint = `http://127.0.0.1:${port}/json/version`;
  while (Date.now() < deadline) {
    throwIfExited(child, 'cdp-attach');
    try {
      const response = await fetch(endpoint);
      if (response.ok) {
        return;
      }
    } catch {
      // The endpoint is expected to be unavailable until WebView has launched.
    }
    await delay(250);
  }
  throw new Error(`CDP endpoint did not become ready within ${timeoutMs}ms: ${endpoint}`);
}

async function waitForApplicationPage(
  context: BrowserContext,
  initialPage: Page,
  timeoutMs = 30_000,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const loadedPage = [initialPage, ...context.pages()].find(
      (page) => page.url() !== 'about:blank',
    );
    if (loadedPage) {
      return loadedPage;
    }
    await delay(250);
  }
  throw new Error(`No loaded application page appeared within ${timeoutMs}ms.`);
}

export function captureTrialUrl(applicationUrl: string): string {
  if (!applicationUrl || applicationUrl === 'about:blank') {
    throw new Error('Capture Trial navigation requires a loaded application URL.');
  }
  try {
    return new URL('/capture-workbench-trial', applicationUrl).href;
  } catch {
    throw new Error('Capture Trial navigation requires a loaded application URL.');
  }
}

async function closeProbeApp(
  child: ChildProcess,
  ownedBeforeClose: readonly ProcessRecord[],
): Promise<ProbeCloseout> {
  const pid = child.pid;
  if (!pid) {
    return {
      normal_close_requested: false,
      exited_after_normal_close: child.exitCode !== null,
      forced_tree_termination: false,
      exit_code: child.exitCode,
      residue: [],
    };
  }
  const normalCloseRequested = requestWindowsCloseByPid(pid);
  let exitedAfterNormalClose = await waitForChildExit(child, DEFAULT_CLOSE_TIMEOUT_MS);
  let forcedTreeTermination = false;
  if (!exitedAfterNormalClose) {
    forcedTreeTermination = true;
    terminateProcessTreeByPid(pid);
    exitedAfterNormalClose = await waitForChildExit(child, DEFAULT_CLOSE_TIMEOUT_MS);
  }

  let residue = remainingOwnedProcesses(ownedBeforeClose);
  for (const processRecord of residue) {
    forcedTreeTermination = true;
    terminateProcessTreeByPid(processRecord.pid);
  }
  if (residue.length > 0) {
    await delay(500);
    residue = remainingOwnedProcesses(ownedBeforeClose);
  }
  return {
    normal_close_requested: normalCloseRequested,
    exited_after_normal_close: exitedAfterNormalClose,
    forced_tree_termination: forcedTreeTermination,
    exit_code: child.exitCode,
    residue: residue.map(processEvidence),
  };
}

async function closeBrowserWithTimeout(
  browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null,
  timeoutMs = 5_000,
): Promise<void> {
  if (!browser) {
    return;
  }
  await Promise.race([
    browser.close(),
    delay(timeoutMs).then(() => {
      throw new Error(`browser close timed out after ${timeoutMs}ms`);
    }),
  ]);
}

async function waitForChildExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  return await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

function remainingOwnedProcesses(
  ownedBeforeClose: readonly ProcessRecord[],
): ProcessRecord[] {
  const currentByPid = new Map(
    snapshotWindowsProcesses().map((record) => [record.pid, record]),
  );
  return ownedBeforeClose.filter((before) => {
    const current = currentByPid.get(before.pid);
    return current ? sameProcessIdentity(before, current) : false;
  });
}

function sameProcessIdentity(
  left: ProcessRecord,
  right: ProcessRecord,
): boolean {
  return (
    left.pid === right.pid &&
    left.name.toLowerCase() === right.name.toLowerCase() &&
    left.creationDate.trim() === right.creationDate.trim()
  );
}

function processEvidence(record: ProcessRecord): ProcessEvidence {
  return {
    pid: record.pid,
    parent_pid: record.parentPid,
    name: record.name,
    image_path: record.executablePath,
  };
}

function throwIfExited(child: ChildProcess, phase: StartupProbePhase): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(
      `${phase} app exited before the phase completed: code=${child.exitCode} signal=${child.signalCode}`,
    );
  }
}

function collectResourceIdentities(executablePath: string): FileIdentity[] {
  return resourceRoots(executablePath)
    .flatMap((root) => listFilesRecursively(root))
    .map(fileIdentity)
    .sort((left, right) => left.path.localeCompare(right.path));
}

function resourceRoots(executablePath: string): string[] {
  const executableDir = dirname(executablePath);
  return [
    join(executableDir, 'resources'),
    join(executableDir, '_up_', 'resources'),
  ].filter((candidate) => existsSync(candidate));
}

function listFilesRecursively(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const candidate = join(root, entry.name);
    return entry.isDirectory() ? listFilesRecursively(candidate) : [candidate];
  });
}

function fileIdentity(path: string): FileIdentity {
  const contents = readFileSync(path);
  return {
    path,
    bytes: statSync(path).size,
    sha256: createHash('sha256').update(contents).digest('hex'),
  };
}

function selectedPhases(selection: ProbePhaseSelection): readonly StartupProbePhase[] {
  return selection === 'all' ? STARTUP_PROBE_PHASES : [selection];
}

function parsePhaseSelection(value: string): ProbePhaseSelection {
  if (value === 'all' || STARTUP_PROBE_PHASES.includes(value as StartupProbePhase)) {
    return value as ProbePhaseSelection;
  }
  throw new Error(`--phase must be one of: all, ${STARTUP_PROBE_PHASES.join(', ')}.`);
}

function assertFreshProbeDirectories(options: ProbeOptions): void {
  if (existsSync(options.outDir)) {
    throw new Error(`Probe output directory must not exist: ${options.outDir}`);
  }
  const appDataRelative = relative(options.outDir, options.appDataDir);
  if (
    !appDataRelative ||
    appDataRelative === '..' ||
    appDataRelative.startsWith(`..${sep}`)
  ) {
    throw new Error('Probe app-data directory must be a fresh descendant of the output directory.');
  }
  mkdirSync(dirname(options.outDir), { recursive: true });
}

function writeProbeReport(outDir: string, report: ProbeReport): void {
  writeFileSync(join(outDir, 'startup-probe.json'), `${JSON.stringify(report, null, 2)}\n`);
}

function isSensitiveEnvironmentName(name: string): boolean {
  return /token|bearer|authorization|secret|password|credential|api[_-]?key/i.test(name);
}

function redactSensitiveText(value: string): string {
  return SENSITIVE_TEXT_PATTERNS.reduce(
    (redacted, pattern) => redacted.replace(pattern, '$1[REDACTED]'),
    value,
  );
}

function probeEnvironmentEvidence(
  environment: Readonly<NodeJS.ProcessEnv>,
): Record<string, string> {
  return redactProbeEnvironment(
    Object.fromEntries(
      Object.entries(environment).filter(([name]) => {
        const normalized = name.toLowerCase();
        return (
          normalized === 'no_proxy' ||
          normalized.startsWith('cert_prep_') ||
          normalized.startsWith('ollama_') ||
          normalized.startsWith('webview2_') ||
          normalized.startsWith('capture_runtime_')
        );
      }),
    ),
  );
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a positive integer no greater than 65535.`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultWorkspaceRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  runDesktopStartupProbeCli().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
