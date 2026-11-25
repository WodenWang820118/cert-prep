/**
 * Starts the published Capture Runtime, the Cert Prep dev servers and the
 * real-engine Playwright journey, then stops only the processes this run started.
 *
 * Tokens stay in child environments. Logs are redacted before they are written.
 * Children do not inherit ambient CAPTURE_, OLLAMA_ or CERT_PREP_ variables, or
 * GITHUB_PACKAGES_TOKEN. CAPTURE_ENGINE_CACHE_DIR is the inherited exception.
 * The run tree is kept because the engine installs are large.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { normalizeRecognizedText } from './anchors.mts';
import {
  CAPTURE_DOCUMENT_SCHEMA_VERSION,
  CAPTURE_RUNTIME_API_VERSION,
  CLEANUP_WAIT_MS,
  DEFAULT_SPEECH_MODEL,
  ENV_ADAPTERS,
  ENV_API_BASE_URL,
  ENV_API_TOKEN,
  ENV_BASE_URL,
  ENV_DEVICES_CLI,
  ENV_ENGINE_ROOT,
  ENV_IMAGE,
  ENV_OLLAMA_MODELS,
  ENV_OLLAMA_PORT,
  ENV_PDF,
  ENV_PLAYWRIGHT_OUTPUT,
  ENV_RECORDING,
  ENV_ROOT,
  ENV_RUN,
  ENV_RUNTIME_PID,
  ENV_RUNTIME_VERSION,
  ENV_SPEECH_MODEL,
  JOURNEY_TEST_TIMEOUT_MS,
  MAX_ROOT_LENGTH,
  PROCESS_READY_TIMEOUT_MS,
  REAL_ENGINES_TARGET,
  RUNTIME_EXECUTABLE,
  SHORT_COMMAND_TIMEOUT_MS,
  WINDOWS_SCRIPT_TIMEOUT_MS,
} from './budgets.mts';
import { killIfRecordedProcess, readProcessCreationTicks, sameSpawnedProcess, spawnTimedOut } from './devices.mts';
import { redactSecrets } from './redact.mts';

export { REAL_ENGINES_TARGET };

const SPEECH_MODEL_PATTERN = /^[A-Za-z0-9._:-]+$/u;
const INSTALLER_TIMEOUT_MS = 10 * 60_000;
const BLOCKED_PREFIXES = ['CAPTURE_', 'OLLAMA_', 'CERT_PREP_'];
const KEPT_INHERITED_NAME = 'CAPTURE_ENGINE_CACHE_DIR';
const STRIPPED_NAMES = new Set([
  'CAPTURE_API_TOKEN',
  'CERT_PREP_API_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NODE_AUTH_TOKEN',
  'NPM_TOKEN',
  'GITHUB_PACKAGES_TOKEN',
]);

class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

interface Inputs {
  readonly root: string;
  readonly pdfPath: string;
  readonly imagePath: string;
  readonly recordingPath: string;
  readonly speechModel: string;
  readonly ollamaModels: string | null;
  readonly engineCache: string | null;
  readonly runtimeVersion: string;
}

interface OwnedProcess {
  readonly name: string;
  readonly child: ChildProcess;
  creationTime: string | null;
  port?: number;
}

interface OwnedPid {
  readonly pid: number;
  readonly creationTicks: string;
}

/** Ports chosen for this run. `ollama` is set as soon as it is reserved, before any child starts. */
interface AllocatedPorts {
  ollama?: number;
}

interface CleanupCheck {
  readonly check: string;
  readonly passed: boolean;
  readonly remaining?: number;
}

interface ReportPhase {
  readonly phase: string;
  readonly passed: boolean;
  readonly durationMs: number;
  readonly anchors?: { readonly found: number; readonly expected: number };
  readonly device?: {
    readonly designed: string;
    readonly reported: string;
    readonly observed: string;
    readonly verdict: string;
    readonly reasons: readonly string[];
    readonly sampleCount: number;
    readonly nvidiaSampleCount: number;
    readonly nvidiaMaxUtilization: number | null;
  };
}

export function backendServeArguments(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Backend port is invalid.');
  // The serve command already passes --port 8765. Nx appends this, and uvicorn keeps the later port.
  return `--args=--port=${port}`;
}

export function keptRunTreeMarker(createdAt: string): {
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly target: string;
  readonly reason: string;
} {
  return {
    schemaVersion: 1,
    createdAt,
    target: REAL_ENGINES_TARGET,
    reason: 'real engine installs',
  };
}

function workspaceRoot(): string {
  return fileURLToPath(new URL('../../../..', import.meta.url));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new InputError(`A required input is missing: ${name}.`);
  return value;
}

function nested(child: string, parent: string): boolean {
  const left = resolve(child).toLowerCase();
  const right = resolve(parent).toLowerCase();
  const prefix = right.endsWith('\\') ? right : `${right}\\`;
  return left === right || left.startsWith(prefix);
}

async function assertFile(filePath: string, label: string): Promise<void> {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw new InputError(`The ${label} input is missing.`);
  }
  if (!info.isFile()) throw new InputError(`The ${label} input is missing.`);
}

async function assertAnchorFile(filePath: string, label: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(`${filePath}.expected.json`, 'utf8')) as unknown;
  } catch {
    throw new InputError(`The ${label} anchor file is invalid.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InputError(`The ${label} anchor file is invalid.`);
  }
  const record = parsed as Record<string, unknown>;
  const anchors = record['rawTextIncludes'];
  if (
    record['schemaVersion'] !== 1 ||
    !Array.isArray(anchors) ||
    anchors.length === 0 ||
    !anchors.every((anchor) => typeof anchor === 'string' && normalizeRecognizedText(anchor).length > 0)
  ) {
    throw new InputError(`The ${label} anchor file is invalid.`);
  }
}

async function readInputs(workspace: string): Promise<Inputs> {
  const rootValue = requiredEnv(ENV_ROOT);
  const root = rootValue.length > 3 ? rootValue.replace(/[\\/]+$/u, '') : rootValue;
  if (!isAbsolute(root) || root.length > MAX_ROOT_LENGTH || nested(root, workspace) || nested(workspace, root)) {
    throw new InputError('The real-engine root must be a short absolute path outside this workspace.');
  }
  const pdfPath = requiredEnv(ENV_PDF);
  const imagePath = requiredEnv(ENV_IMAGE);
  const recordingPath = requiredEnv(ENV_RECORDING);
  for (const [filePath, label] of [
    [pdfPath, 'PDF'],
    [imagePath, 'image'],
    [recordingPath, 'recording'],
  ] as const) {
    if (!isAbsolute(filePath)) throw new InputError(`The ${label} input is missing.`);
    await assertFile(filePath, label);
    await assertAnchorFile(filePath, label);
  }
  const speechModel = process.env[ENV_SPEECH_MODEL]?.trim() || DEFAULT_SPEECH_MODEL;
  if (!SPEECH_MODEL_PATTERN.test(speechModel)) throw new InputError('The speech model is invalid.');
  const modelsValue = process.env[ENV_OLLAMA_MODELS]?.trim();
  if (modelsValue) {
    if (!isAbsolute(modelsValue)) throw new InputError('The Ollama models directory is missing.');
    const info = await stat(modelsValue).catch(() => null);
    if (!info?.isDirectory()) throw new InputError('The Ollama models directory is missing.');
  }
  const engineCache = process.env['CAPTURE_ENGINE_CACHE_DIR']?.trim() || null;
  if (engineCache && !isAbsolute(engineCache)) throw new InputError('CAPTURE_ENGINE_CACHE_DIR must be an absolute path.');
  const pin = JSON.parse(await readFile(join(workspace, 'tools', 'capture-runtime-version.json'), 'utf8')) as unknown;
  const runtimeVersion =
    pin && typeof pin === 'object' && !Array.isArray(pin) ? (pin as Record<string, unknown>)['runtimeVersion'] : undefined;
  if (typeof runtimeVersion !== 'string' || !/^\d+\.\d+\.\d+$/u.test(runtimeVersion)) {
    throw new InputError('Capture Runtime pin is unreadable.');
  }
  return {
    root: resolve(root),
    pdfPath,
    imagePath,
    recordingPath,
    speechModel,
    ollamaModels: modelsValue ? resolve(modelsValue) : null,
    engineCache,
    runtimeVersion,
  };
}

function ollamaInstalled(): boolean {
  const localAppData = process.env['LOCALAPPDATA'];
  if (localAppData && existsSync(join(localAppData, 'Programs', 'Ollama', 'ollama.exe'))) return true;
  const result = spawnSync('where.exe', ['ollama'], {
    windowsHide: true,
    stdio: 'ignore',
    timeout: SHORT_COMMAND_TIMEOUT_MS,
  });
  if (spawnTimedOut(result.error)) {
    throw new InputError(`where.exe timed out after ${SHORT_COMMAND_TIMEOUT_MS} ms.`);
  }
  return result.status === 0;
}

function remember(secrets: string[], value: string): string {
  if (value.length >= 8) secrets.push(value);
  return value;
}

function inheritedNameBlocked(name: string): boolean {
  const upper = name.toUpperCase();
  if (STRIPPED_NAMES.has(upper)) return true;
  if (upper === KEPT_INHERITED_NAME) return false;
  return BLOCKED_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * Drops ambient engine controls and package tokens, then applies explicit overrides.
 * CAPTURE_ENGINE_CACHE_DIR is the one inherited exception.
 */
export function childEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  overrides: Readonly<Record<string, string>>,
  options?: { readonly githubToken?: boolean },
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || inheritedNameBlocked(key)) continue;
    environment[key] = value;
  }
  if (options?.githubToken) {
    for (const [key, value] of Object.entries(source)) {
      const upper = key.toUpperCase();
      if ((upper === 'GITHUB_TOKEN' || upper === 'GH_TOKEN') && value) environment[key] = value;
    }
  }
  return { ...environment, ...overrides };
}

function pipeLogs(stream: NodeJS.ReadableStream | null, file: string, secrets: readonly string[]): void {
  if (!stream) return;
  const lines = createInterface({ input: stream });
  lines.on('line', (line) => {
    appendFileSync(file, `${redactSecrets(line, secrets)}\n`);
  });
}

function track(child: ChildProcess): void {
  child.once('error', () => undefined);
}

async function createRunTree(inputs: Inputs, started: Date): Promise<string> {
  const stamp = started.toISOString().replace(/[-:.]/gu, '');
  const runDir = join(inputs.root, `run-${stamp}`);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'kept-run-tree.json'), `${JSON.stringify(keptRunTreeMarker(started.toISOString()), null, 2)}\n`, 'utf8');
  // The runtime directory is created by install-capture-runtime, which refuses an existing one.
  for (const name of ['temp', 'logs', 'playwright', 'cert-data', 'capture-app-data']) {
    await mkdir(join(runDir, name), { recursive: true });
  }
  if (!inputs.ollamaModels) await mkdir(join(runDir, 'ollama-models'), { recursive: true });
  return runDir;
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', () => rejectPort(new InputError('No free loopback port was available.')));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        rejectPort(new InputError('No free loopback port was available.'));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? rejectPort(error) : resolvePort(port)));
    });
  });
}

function portAccepting(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (accepting: boolean): void => {
      socket.destroy();
      resolvePort(accepting);
    };
    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    return code !== 'ESRCH';
  }
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(null), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
}

function spawnNode(
  workspace: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  logFile: string,
  secrets: readonly string[],
): ChildProcess {
  const child = spawn(process.execPath, [...args], {
    cwd: workspace,
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  track(child);
  pipeLogs(child.stdout, logFile, secrets);
  pipeLogs(child.stderr, logFile, secrets);
  return child;
}

async function waitUntilReady(
  child: ChildProcess,
  label: string,
  probe: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + PROCESS_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new InputError(`${label} exited before it was ready.`);
    try {
      if (await probe()) return;
    } catch (error) {
      if (error instanceof InputError) throw error;
    }
    await delay(500);
  }
  throw new InputError(`${label} did not become ready.`);
}

async function fetchJson(url: string, headers?: Record<string, string>): Promise<{ readonly status: number; readonly body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    const payload = await response.text();
    if (!payload) return { status: response.status, body: null };
    try {
      return { status: response.status, body: JSON.parse(payload) as unknown };
    } catch {
      return { status: response.status, body: null };
    }
  } finally {
    clearTimeout(timer);
  }
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

async function stageRuntime(
  workspace: string,
  runDir: string,
  secrets: string[],
  owned: OwnedProcess[],
): Promise<void> {
  const nxBin = nxCli(workspace);
  const environment = childEnvironment(process.env, {
    CERT_PREP_CAPTURE_RUNTIME_ROOT: join(runDir, 'runtime'),
    TEMP: join(runDir, 'temp'),
    TMP: join(runDir, 'temp'),
    NX_TUI: 'false',
    NX_DAEMON: 'false',
  }, { githubToken: true });
  const child = spawnNode(
    workspace,
    [nxBin, 'run', 'cert-prep-desktop:install-capture-runtime', '--output-style=stream'],
    environment,
    join(runDir, 'logs', 'install-capture-runtime.log'),
    secrets,
  );
  attachOwned('installer', child, owned);
  const code = await waitForExit(child, INSTALLER_TIMEOUT_MS);
  if (code !== 0) throw new InputError('Capture Runtime install failed.');
  if (!existsSync(join(runDir, 'runtime', RUNTIME_EXECUTABLE))) {
    throw new InputError('The staged Capture Runtime executable is missing.');
  }
}

async function startRuntime(
  runDir: string,
  port: number,
  token: string,
  inputs: Inputs,
  secrets: string[],
  owned: OwnedProcess[],
): Promise<void> {
  const executable = join(runDir, 'runtime', RUNTIME_EXECUTABLE);
  const environment = childEnvironment(process.env, {
    TEMP: join(runDir, 'temp'),
    TMP: join(runDir, 'temp'),
    CAPTURE_HOST: '127.0.0.1',
    CAPTURE_PORT: String(port),
    CAPTURE_ALLOWED_HOSTS: `127.0.0.1:${port}`,
    CAPTURE_ALLOWED_ORIGINS: '',
    CAPTURE_API_TOKEN: token,
    CAPTURE_APP_DATA_DIR: join(runDir, 'capture-app-data'),
    CAPTURE_EXTRACTION_PROVIDER: 'runtime',
    CAPTURE_STRUCTURING_PROVIDER: 'host',
    CAPTURE_ENABLE_API_DOCS: 'false',
    CAPTURE_SPEECH_RECOGNITION_VARIANT: 'cuda',
    CAPTURE_SPEECH_RECOGNITION_MODEL: inputs.speechModel,
    CAPTURE_SPEECH_RECOGNITION_ALLOW_CPU_FALLBACK: 'false',
    // CUDA is attempted only when the runtime's GPU preference is on.
    CAPTURE_SPEECH_PREFER_GPU: 'true',
    CAPTURE_OCR_WORKER_IDLE_SECONDS: '0',
    CAPTURE_SPEECH_WORKER_IDLE_SECONDS: '0',
    ...(inputs.engineCache ? { CAPTURE_ENGINE_CACHE_DIR: inputs.engineCache } : {}),
  });
  const child = spawn(executable, ['serve', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: join(runDir, 'runtime'),
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  track(child);
  pipeLogs(child.stdout, join(runDir, 'logs', 'capture-runtime.log'), secrets);
  pipeLogs(child.stderr, join(runDir, 'logs', 'capture-runtime.log'), secrets);
  attachOwned('runtime', child, owned, port);
  await waitUntilReady(child, 'Capture Runtime', async () => {
    const ready = await fetchJson(`http://127.0.0.1:${port}/v2/health/ready`, {
      Authorization: `Bearer ${token}`,
      Connection: 'close',
    });
    if (!ready.status || ready.status === 401 || ready.status >= 500) return false;
    if (ready.status !== 200) return false;
    const body = recordOf(ready.body);
    if (
      body?.['service'] !== 'capture-runtime' ||
      body['runtimeVersion'] !== inputs.runtimeVersion ||
      body['apiVersion'] !== CAPTURE_RUNTIME_API_VERSION ||
      body['captureDocumentSchemaVersion'] !== CAPTURE_DOCUMENT_SCHEMA_VERSION
    ) {
      throw new InputError('Capture Runtime readiness did not match the pinned contract.');
    }
    return true;
  });
}

async function startBackend(
  workspace: string,
  runDir: string,
  ports: { readonly backend: number; readonly frontend: number; readonly runtime: number; readonly ollama: number },
  tokens: { readonly api: string; readonly runtime: string },
  inputs: Inputs,
  secrets: string[],
  owned: OwnedProcess[],
): Promise<void> {
  const nxBin = nxCli(workspace);
  const models = inputs.ollamaModels ?? join(runDir, 'ollama-models');
  const environment = childEnvironment(process.env, {
    TEMP: join(runDir, 'temp'),
    TMP: join(runDir, 'temp'),
    NX_TUI: 'false',
    NX_DAEMON: 'false',
    CERT_PREP_DATA_DIR: join(runDir, 'cert-data'),
    CERT_PREP_API_TOKEN: tokens.api,
    CERT_PREP_LLM_PROVIDER: 'ollama',
    CERT_PREP_OLLAMA_HOST: `http://127.0.0.1:${ports.ollama}`,
    OLLAMA_MODELS: models,
    CERT_PREP_ALLOWED_ORIGINS: JSON.stringify([
      `http://127.0.0.1:${ports.frontend}`,
      `http://localhost:${ports.frontend}`,
    ]),
    CERT_PREP_CAPTURE_RUNTIME_URL: `http://127.0.0.1:${ports.runtime}`,
    CERT_PREP_CAPTURE_RUNTIME_TOKEN: tokens.runtime,
    CERT_PREP_CAPTURE_RUNTIME_VERSION: inputs.runtimeVersion,
    CERT_PREP_CAPTURE_RUNTIME_API_VERSION: CAPTURE_RUNTIME_API_VERSION,
    CERT_PREP_CAPTURE_DOCUMENT_SCHEMA_VERSION: CAPTURE_DOCUMENT_SCHEMA_VERSION,
    CERT_PREP_LLM_INSTALL_TIMEOUT_SECONDS: '3600',
    CERT_PREP_CAPTURE_RUNTIME_JOB_TIMEOUT_SECONDS: '3600',
    CERT_PREP_OLLAMA_TIMEOUT_SECONDS: '900',
  });
  const child = spawnNode(
    workspace,
    [nxBin, 'run', 'cert-prep-backend:serve', '--output-style=stream', backendServeArguments(ports.backend)],
    environment,
    join(runDir, 'logs', 'backend.log'),
    secrets,
  );
  attachOwned('backend', child, owned, ports.backend);
  await waitUntilReady(child, 'Cert Prep backend', async () => {
    const health = await fetchJson(`http://127.0.0.1:${ports.backend}/health`);
    return health.status === 200 && recordOf(health.body)?.['status'] === 'ok';
  });
}

async function startFrontend(
  workspace: string,
  runDir: string,
  port: number,
  secrets: string[],
  owned: OwnedProcess[],
): Promise<void> {
  const nxBin = nxCli(workspace);
  const environment = childEnvironment(process.env, {
    TEMP: join(runDir, 'temp'),
    TMP: join(runDir, 'temp'),
    NX_TUI: 'false',
    NX_DAEMON: 'false',
  });
  const child = spawnNode(
    workspace,
    [nxBin, 'run', 'cert-prep:serve', `--port=${port}`, '--host=127.0.0.1', '--output-style=stream'],
    environment,
    join(runDir, 'logs', 'frontend.log'),
    secrets,
  );
  attachOwned('frontend', child, owned, port);
  await waitUntilReady(child, 'Cert Prep frontend', async () => {
    const page = await fetchJson(`http://127.0.0.1:${port}/`);
    return page.status === 200;
  });
}

async function runPlaywright(
  workspace: string,
  runDir: string,
  inputs: Inputs,
  ports: { readonly backend: number; readonly frontend: number; readonly ollama: number },
  apiToken: string,
  runtimePid: number,
  secrets: string[],
  owned: OwnedProcess[],
): Promise<number> {
  const cli = join(workspace, 'node_modules', '@playwright', 'test', 'cli.js');
  if (!existsSync(cli)) throw new InputError('Playwright is not installed.');
  const environment = childEnvironment(process.env, {
    TEMP: join(runDir, 'temp'),
    TMP: join(runDir, 'temp'),
    [ENV_BASE_URL]: `http://127.0.0.1:${ports.frontend}`,
    [ENV_PLAYWRIGHT_OUTPUT]: join(runDir, 'playwright'),
    [ENV_RUN]: runDir,
    [ENV_API_BASE_URL]: `http://127.0.0.1:${ports.backend}`,
    [ENV_API_TOKEN]: apiToken,
    [ENV_PDF]: inputs.pdfPath,
    [ENV_IMAGE]: inputs.imagePath,
    [ENV_RECORDING]: inputs.recordingPath,
    [ENV_SPEECH_MODEL]: inputs.speechModel,
    [ENV_RUNTIME_PID]: String(runtimePid),
    [ENV_ENGINE_ROOT]: join(runDir, 'capture-app-data', 'engines'),
    [ENV_OLLAMA_PORT]: String(ports.ollama),
    [ENV_ADAPTERS]: join(runDir, 'adapters.json'),
    [ENV_DEVICES_CLI]: fileURLToPath(new URL('./devices.mts', import.meta.url)),
    [ENV_RUNTIME_VERSION]: inputs.runtimeVersion,
  });
  const child = spawnNode(
    workspace,
    [cli, 'test', '-c', join(workspace, 'apps', 'cert-prep-e2e', 'playwright.real-engines.config.mts')],
    environment,
    join(runDir, 'logs', 'playwright.log'),
    secrets,
  );
  const playwright = attachOwned('playwright', child, owned);
  const code = await waitForExit(child, JOURNEY_TEST_TIMEOUT_MS + 180_000);
  if (code === null) {
    killRecorded(child, playwright.creationTime);
    return 1;
  }
  return code;
}

/** The Nx CLI script, from the installed package's own `bin` entry. */
function nxCli(workspace: string): string {
  const packageRoot = join(workspace, 'node_modules', 'nx');
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  } catch {
    throw new InputError('Nx is not installed.');
  }
  const bin = recordOf(recordOf(manifest)?.['bin'])?.['nx'];
  const script = typeof bin === 'string' ? join(packageRoot, bin) : undefined;
  if (!script || !existsSync(script)) throw new InputError('Nx is not installed.');
  return script;
}

const ownedProcessScript = String.raw`
param([string]$RootList)
$ErrorActionPreference = 'SilentlyContinue'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$processTable = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CreationDate)
$byId = @{}
foreach ($processRow in $processTable) { $byId[[int]$processRow.ProcessId] = $processRow }
$ownedIds = [System.Collections.Generic.HashSet[int]]::new()
foreach ($rootText in ($RootList -split ',')) {
  $rootId = 0
  if ([int]::TryParse($rootText.Trim(), [ref]$rootId) -and $rootId -gt 0 -and $byId.ContainsKey($rootId)) {
    [void]$ownedIds.Add($rootId)
  }
}
do {
  $changed = $false
  foreach ($processRow in $processTable) {
    $processId = [int]$processRow.ProcessId
    $parentId = [int]$processRow.ParentProcessId
    if (-not $ownedIds.Contains($parentId) -or $ownedIds.Contains($processId)) { continue }
    $parentRow = $byId[$parentId]
    if ($null -eq $parentRow -or $null -eq $parentRow.CreationDate -or $null -eq $processRow.CreationDate) { continue }
    # A recycled PID is older than the parent that now owns that number.
    $parentTicks = [int64]$parentRow.CreationDate.ToUniversalTime().Ticks
    $childTicks = [int64]$processRow.CreationDate.ToUniversalTime().Ticks
    if ($childTicks -le $parentTicks) { continue }
    if ($ownedIds.Add($processId)) { $changed = $true }
  }
} while ($changed)
foreach ($processId in $ownedIds) {
  $processRow = $byId[$processId]
  if ($null -eq $processRow -or $null -eq $processRow.CreationDate) { continue }
  Write-Output ([string]$processId + ',' + [string]$processRow.CreationDate.ToUniversalTime().Ticks)
}
`;

function nodeStillRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function readCreationTime(pid: number): string | null {
  try {
    return readProcessCreationTicks(pid);
  } catch (error) {
    throw new InputError(failureMessage(error, 'Reading process creation time timed out.'));
  }
}

function killRecorded(child: ChildProcess, creationTime: string | null): void {
  try {
    killIfRecordedProcess(child, creationTime);
  } catch (error) {
    throw new InputError(failureMessage(error, 'taskkill timed out.'));
  }
}

/** Records the Win32 creation time immediately after spawn so a later kill can prove the PID is still that child. */
function attachOwned(name: string, child: ChildProcess, owned: OwnedProcess[], port?: number): OwnedProcess {
  const record: OwnedProcess = { name, child, creationTime: null, ...(port !== undefined ? { port } : {}) };
  owned.push(record);
  if (!child.pid) return record;
  record.creationTime = readCreationTime(child.pid);
  // spawnSync blocks the event loop, so a child that exits during the read is
  // still "running" for Node; only a PID that is still alive must be readable.
  if (record.creationTime === null && nodeStillRunning(child) && pidAlive(child.pid)) {
    throw new InputError('The process creation time was not readable.');
  }
  return record;
}

function parseOwnedPidLine(line: string): OwnedPid | null {
  const [pidText, ticksText] = line.trim().split(',');
  const ticks = ticksText?.trim() ?? '';
  const pid = Number(pidText);
  if (!pidText || !Number.isInteger(pid) || pid < 1 || !/^\d+$/u.test(ticks)) return null;
  return { pid, creationTicks: ticks };
}

function snapshotOwned(runDir: string, roots: readonly OwnedPid[]): readonly OwnedPid[] {
  if (roots.length === 0) return [];
  const scriptPath = join(runDir, 'temp', 'owned-processes.ps1');
  writeFileSync(scriptPath, ownedProcessScript);
  const powershell = `${process.env['SystemRoot'] ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const result = spawnSync(
    powershell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-RootList', roots.map((root) => root.pid).join(',')],
    { windowsHide: true, encoding: 'utf8', timeout: WINDOWS_SCRIPT_TIMEOUT_MS },
  );
  if (spawnTimedOut(result.error)) {
    throw new InputError(`owned-processes.ps1 timed out after ${WINDOWS_SCRIPT_TIMEOUT_MS} ms.`);
  }
  if (result.error || result.status !== 0) throw new InputError('owned-processes.ps1 failed.');
  const byPid = new Map<number, OwnedPid>();
  for (const root of roots) byPid.set(root.pid, root);
  const stdout = (result.stdout ?? '').replace(/^\uFEFF/u, '').replace(/\0/g, '');
  for (const line of stdout.split(/\r?\n/u)) {
    const parsed = parseOwnedPidLine(line);
    if (!parsed) continue;
    const root = roots.find((item) => item.pid === parsed.pid);
    if (root) {
      if (root.creationTicks !== parsed.creationTicks) byPid.delete(parsed.pid);
      continue;
    }
    byPid.set(parsed.pid, parsed);
  }
  return [...byPid.values()];
}

function stillTheSnapshotProcess(entry: OwnedPid): boolean {
  if (!pidAlive(entry.pid)) return false;
  const live = readCreationTime(entry.pid);
  return live !== null && live === entry.creationTicks;
}

async function stopOwned(
  runDir: string,
  owned: readonly OwnedProcess[],
  ollamaPort: number | undefined,
): Promise<readonly CleanupCheck[]> {
  const launched = owned.filter((item) => item.child.pid !== undefined);
  const order = ['playwright', 'frontend', 'backend', 'runtime', 'installer'];
  const checks: CleanupCheck[] = [];
  // Windows reuses PIDs. Snapshot and kill only children Node still tracks, and only when the creation time matches.
  const confirmed: OwnedProcess[] = [];
  for (const item of launched) {
    const pid = item.child.pid;
    if (!pid || !nodeStillRunning(item.child)) continue;
    try {
      const live = readCreationTime(pid);
      if (sameSpawnedProcess({ stillRunning: true, recordedCreation: item.creationTime, liveCreation: live })) {
        confirmed.push(item);
      }
    } catch (error) {
      checks.push({ check: failureMessage(error, 'Reading process creation time timed out.'), passed: false });
    }
  }
  const roots: OwnedPid[] = confirmed.flatMap((item) => {
    const pid = item.child.pid;
    if (!pid || !item.creationTime) return [];
    return [{ pid, creationTicks: item.creationTime }];
  });
  let snapshot: readonly OwnedPid[] = roots;
  try {
    snapshot = snapshotOwned(runDir, roots);
  } catch (error) {
    checks.push({ check: failureMessage(error, 'owned-processes.ps1 failed.'), passed: false });
  }
  for (const name of order) {
    const ownedProcess = confirmed.find((item) => item.name === name);
    if (!ownedProcess) continue;
    try {
      killRecorded(ownedProcess.child, ownedProcess.creationTime);
    } catch (error) {
      checks.push({ check: failureMessage(error, 'taskkill timed out.'), passed: false });
    }
  }
  // Cert starts Ollama as a child of the backend. Check that port only when the backend was launched.
  const backend = launched.find((item) => item.name === 'backend');
  const ollamaToCheck = backend && ollamaPort !== undefined && Number.isInteger(ollamaPort) && ollamaPort > 0 ? ollamaPort : undefined;
  const deadline = Date.now() + CLEANUP_WAIT_MS;
  let portsQuiet = false;
  let processesQuiet = false;
  while (Date.now() < deadline) {
    portsQuiet = true;
    for (const ownedProcess of launched) {
      if (ownedProcess.port !== undefined && (await portAccepting(ownedProcess.port))) portsQuiet = false;
    }
    if (backend && (ollamaToCheck === undefined || (await portAccepting(ollamaToCheck)))) portsQuiet = false;
    processesQuiet = snapshot.every((entry) => !pidAlive(entry.pid));
    if (portsQuiet && processesQuiet) break;
    await delay(500);
  }
  for (const name of ['runtime', 'backend', 'frontend']) {
    const ownedProcess = launched.find((item) => item.name === name);
    if (!ownedProcess) continue;
    checks.push({
      check: `${name} port closed`,
      passed: ownedProcess.port !== undefined && !(await portAccepting(ownedProcess.port)),
    });
  }
  if (backend) {
    checks.push({
      check: 'ollama port closed',
      passed: ollamaToCheck !== undefined && !(await portAccepting(ollamaToCheck)),
    });
  }
  try {
    const remaining = snapshot.filter((entry) => stillTheSnapshotProcess(entry)).length;
    checks.push({ check: 'owned processes stopped', passed: remaining === 0, remaining });
  } catch (error) {
    checks.push({ check: failureMessage(error, 'Reading process creation time timed out.'), passed: false });
  }
  for (const ownedProcess of launched) {
    const pid = ownedProcess.child.pid;
    if (!pid || !nodeStillRunning(ownedProcess.child)) {
      checks.push({ check: `${ownedProcess.name} process stopped`, passed: true, remaining: 0 });
      continue;
    }
    if (ownedProcess.creationTime === null) {
      checks.push({ check: `${ownedProcess.name} process creation time was not recorded`, passed: false, remaining: 1 });
      continue;
    }
    try {
      const live = readCreationTime(pid);
      const ours = sameSpawnedProcess({
        stillRunning: true,
        recordedCreation: ownedProcess.creationTime,
        liveCreation: live,
      });
      checks.push({ check: `${ownedProcess.name} process stopped`, passed: !ours, remaining: ours ? 1 : 0 });
    } catch (error) {
      checks.push({ check: failureMessage(error, 'Reading process creation time timed out.'), passed: false });
    }
  }
  return checks;
}

async function removePrivateArtifacts(directory: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(directory, entry.name);
    const lower = entry.name.toLowerCase();
    if (entry.isDirectory()) {
      if (lower === 'trace') {
        await rm(full, { force: true, recursive: true }).catch(() => undefined);
        continue;
      }
      await removePrivateArtifacts(full);
      continue;
    }
    if (
      lower === 'error-context.md' ||
      lower === 'trace' ||
      lower.startsWith('trace.') ||
      lower.endsWith('.webm') ||
      lower.endsWith('.png') ||
      lower.endsWith('.zip')
    ) {
      await rm(full, { force: true }).catch(() => undefined);
    }
  }
}

function parsePhase(value: unknown): ReportPhase | null {
  const record = recordOf(value);
  const phase = record ? record['phase'] : undefined;
  const passed = record ? record['passed'] : undefined;
  const durationMs = record ? record['durationMs'] : undefined;
  if (typeof phase !== 'string' || !/^[a-z0-9-]+$/u.test(phase) || typeof passed !== 'boolean' || typeof durationMs !== 'number') {
    return null;
  }
  const anchors = recordOf(record?.['anchors']);
  const device = recordOf(record?.['device']);
  const reasons = device?.['reasons'];
  const parsed: ReportPhase = {
    phase,
    passed,
    durationMs,
    ...(anchors && typeof anchors['found'] === 'number' && typeof anchors['expected'] === 'number'
      ? { anchors: { found: anchors['found'], expected: anchors['expected'] } }
      : {}),
    ...(device &&
    typeof device['designed'] === 'string' &&
    typeof device['reported'] === 'string' &&
    typeof device['observed'] === 'string' &&
    typeof device['verdict'] === 'string' &&
    Array.isArray(reasons) &&
    reasons.every((reason) => typeof reason === 'string') &&
    typeof device['sampleCount'] === 'number' &&
    typeof device['nvidiaSampleCount'] === 'number' &&
    (device['nvidiaMaxUtilization'] === null || typeof device['nvidiaMaxUtilization'] === 'number')
      ? {
          device: {
            designed: device['designed'],
            reported: device['reported'],
            observed: device['observed'],
            verdict: device['verdict'],
            reasons,
            sampleCount: device['sampleCount'],
            nvidiaSampleCount: device['nvidiaSampleCount'],
            nvidiaMaxUtilization: device['nvidiaMaxUtilization'],
          },
        }
      : {}),
  };
  return parsed;
}

async function readPhases(file: string): Promise<ReportPhase[]> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
    const phases = recordOf(parsed)?.['phases'];
    if (!Array.isArray(phases)) return [];
    return phases.flatMap((phase) => {
      const parsedPhase = parsePhase(phase);
      return parsedPhase ? [parsedPhase] : [];
    });
  } catch {
    return [];
  }
}

async function listAdapters(workspace: string, runDir: string, secrets: string[]): Promise<void> {
  const devicesCli = fileURLToPath(new URL('./devices.mts', import.meta.url));
  const child = spawnNode(
    workspace,
    [devicesCli, 'adapters', '--out', join(runDir, 'adapters.json')],
    childEnvironment(process.env, { TEMP: join(runDir, 'temp'), TMP: join(runDir, 'temp') }),
    join(runDir, 'logs', 'adapters.log'),
    secrets,
  );
  let creationTime: string | null = null;
  if (child.pid) {
    creationTime = readCreationTime(child.pid);
    if (creationTime === null && nodeStillRunning(child) && pidAlive(child.pid)) {
      throw new InputError('The process creation time was not readable.');
    }
  }
  const code = await waitForExit(child, 60_000);
  if (code === null) killRecorded(child, creationTime);
  if (code !== 0 || !existsSync(join(runDir, 'adapters.json'))) throw new InputError('No GPU adapters were listed.');
}

function safeMessage(error: unknown): string {
  return error instanceof InputError ? error.message : 'The real-engine journey failed.';
}

async function execute(
  workspace: string,
  inputs: Inputs,
  runDir: string,
  secrets: string[],
  owned: OwnedProcess[],
  ports: AllocatedPorts,
): Promise<number> {
  await listAdapters(workspace, runDir, secrets);
  const runtimePort = await freePort();
  const backendPort = await freePort();
  const frontendPort = await freePort();
  const ollamaPort = await freePort();
  ports.ollama = ollamaPort;
  // Every token this run creates is registered for redaction before a child starts.
  const runtimeToken = remember(secrets, randomBytes(32).toString('hex'));
  const apiToken = remember(secrets, randomBytes(32).toString('hex'));
  await stageRuntime(workspace, runDir, secrets, owned);
  await startRuntime(runDir, runtimePort, runtimeToken, inputs, secrets, owned);
  await startBackend(
    workspace,
    runDir,
    { backend: backendPort, frontend: frontendPort, runtime: runtimePort, ollama: ollamaPort },
    { api: apiToken, runtime: runtimeToken },
    inputs,
    secrets,
    owned,
  );
  await startFrontend(workspace, runDir, frontendPort, secrets, owned);
  const runtime = owned.find((process) => process.name === 'runtime');
  if (!runtime?.child.pid) throw new InputError('Capture Runtime did not start.');
  return runPlaywright(
    workspace,
    runDir,
    inputs,
    { backend: backendPort, frontend: frontendPort, ollama: ollamaPort },
    apiToken,
    runtime.child.pid,
    secrets,
    owned,
  );
}

async function main(): Promise<number> {
  if (process.platform !== 'win32') {
    process.stderr.write('The real-engine dev-server journey runs on Windows only.\n');
    return 1;
  }
  const started = new Date();
  const secrets: string[] = [];
  for (const key of ['GITHUB_TOKEN', 'GH_TOKEN', 'NODE_AUTH_TOKEN', 'NPM_TOKEN', 'GITHUB_PACKAGES_TOKEN']) {
    const value = process.env[key];
    if (value) remember(secrets, value);
  }
  const owned: OwnedProcess[] = [];
  const ports: AllocatedPorts = {};
  let runDir: string | undefined;
  let playwrightExit: number | null = null;
  let startupFailed = false;
  try {
    const workspace = workspaceRoot();
    const inputs = await readInputs(workspace);
    if (!ollamaInstalled()) {
      process.stderr.write('Ollama is not installed. This journey does not install system software.\n');
      return 1;
    }
    runDir = await createRunTree(inputs, started);
    playwrightExit = await execute(workspace, inputs, runDir, secrets, owned, ports);
  } catch (error) {
    startupFailed = true;
    if (!runDir) {
      process.stderr.write(`${safeMessage(error)}\n`);
      return 1;
    }
    appendFileSync(join(runDir, 'logs', 'orchestrator.log'), `${redactSecrets(safeMessage(error), secrets)}\n`);
  }
  if (!runDir) return 1;
  let cleanup: readonly CleanupCheck[] = [];
  try {
    cleanup = await stopOwned(runDir, owned, ports.ollama);
  } catch {
    cleanup = [{ check: 'cleanup', passed: false }];
  }
  await removePrivateArtifacts(join(runDir, 'playwright'));
  let phases = await readPhases(join(runDir, 'journey.json'));
  if (startupFailed && phases.length === 0) {
    phases = [{ phase: 'startup', passed: false, durationMs: Date.now() - started.getTime() }];
  }
  const phasesPassed = phases.length > 0 && phases.every((phase) => phase.passed);
  const cleanupPassed = cleanup.every((check) => check.passed);
  const passed = playwrightExit === 0 && phasesPassed && cleanupPassed && !startupFailed;
  const report = {
    schemaVersion: 1,
    target: REAL_ENGINES_TARGET,
    startedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    passed,
    phases,
    cleanup,
  };
  await writeFile(join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${runDir}\n`);
  if (!passed) process.stderr.write('The real-engine journey failed.\n');
  return passed ? 0 : 1;
}

function invokedDirectly(): boolean {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  return pathToFileURL(resolve(argvPath)).href.toLowerCase() === import.meta.url.toLowerCase();
}

if (invokedDirectly()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.stderr.write('The real-engine journey failed.\n');
      process.exitCode = 1;
    });
}
