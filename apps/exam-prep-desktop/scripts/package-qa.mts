import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_TARGET_TRIPLE = 'x86_64-pc-windows-msvc';
const DEFAULT_OUTPUT = 'tmp/exam-prep-desktop/package-qa/package-qa.json';
const DEFAULT_BUNDLE_ROOT =
  `apps/exam-prep-desktop/src-tauri/target/${DEFAULT_TARGET_TRIPLE}/release/bundle`;
const DEFAULT_SIDECAR_DIR = 'apps/exam-prep-desktop/src-tauri/binaries';
const DEFAULT_OCR_RUNTIME_ROOT = 'apps/exam-prep-backend/dist/ocr-runtime';
const DEFAULT_OCR_RUNTIME_MANIFEST =
  'apps/exam-prep-desktop/src-tauri/resources/ocr-runtime-manifest.json';
const DEFAULT_DATA_DIR = 'tmp/exam-prep-desktop/package-qa/data';
const DEFAULT_LLM_MODEL = 'gemma4:12b';
const SIDECAR_PREFIX = 'exam-prep-backend-';
const CAPTURE_LIMIT = 12_000;
const INITIAL_INSTALLER_WARNING_MB = 150;
const INITIAL_INSTALLER_ERROR_MB = 250;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultWorkspaceRoot = resolve(scriptDir, '../../..');

interface PackageQaOptions {
  readonly workspaceRoot?: string;
  readonly bundleRoot?: string;
  readonly sidecarDir?: string;
  readonly ocrRuntimeRoot?: string;
  readonly ocrRuntimeManifest?: string;
  readonly expectedTargetTriple?: string;
  readonly healthTimeoutMs?: number;
  readonly dataDir?: string;
  readonly llmModel?: string;
}

interface RuntimeHealthOptions {
  readonly sidecarPath: string;
  readonly workspaceRoot?: string;
  readonly timeoutMs?: number;
  readonly dataDir?: string;
  readonly llmModel?: string;
  readonly ocrRuntimeManifest?: string;
}

interface FileRecord {
  readonly absolutePath: string;
  readonly path: string;
  readonly bytes: number;
  readonly mb: number;
}

interface PublicFileRecord {
  readonly path: string;
  readonly bytes: number;
  readonly mb: number;
}

type SizeGateStatus = 'passed' | 'warning' | 'failed';

interface SizeGate {
  readonly status: SizeGateStatus;
  readonly largest_initial_mb: number;
  readonly warning_mb: number;
  readonly error_mb: number;
  readonly detail: string;
}

interface OcrHealthSummary {
  readonly provider: unknown;
  readonly engine: unknown;
  readonly available: unknown;
  readonly detail: unknown;
  readonly selected_device: unknown;
  readonly cuda_available: unknown;
  readonly gpu_count: unknown;
  readonly fallback_reason: unknown;
  readonly unavailable_reason: unknown;
}

interface LlmHealthSummary {
  readonly provider: unknown;
  readonly model: unknown;
  readonly available: unknown;
  readonly detail: unknown;
  readonly unavailable_reason: unknown;
}

interface RuntimeHealthSummary {
  readonly launch_env: {
    readonly EXAM_PREP_OCR_PROVIDER: 'paddle';
    readonly EXAM_PREP_OCR_RUNTIME_MODE: 'external';
    readonly EXAM_PREP_OCR_DEVICE: 'auto';
    readonly EXAM_PREP_LLM_PROVIDER: 'ollama';
    readonly EXAM_PREP_OLLAMA_MODEL: string;
  };
  readonly system_health: unknown;
  readonly ocr_health: OcrHealthSummary;
  readonly llm_health: LlmHealthSummary;
  readonly raw_health: {
    readonly ocr: JsonRecord;
    readonly llm: JsonRecord;
  };
  readonly sidecar_output_tail: OutputCapture;
}

interface PackageQaReport {
  readonly schema_version: 1;
  readonly generated_at: string;
  readonly target: {
    readonly rust_triple: string;
    readonly platform: NodeJS.Platform;
    readonly arch: string;
  };
  readonly package: {
    readonly bundle_root: string;
    readonly bundle_artifacts: PublicFileRecord[];
    readonly sidecar: PublicFileRecord;
    readonly ocr_runtime_root: string;
    readonly ocr_runtime_artifacts: PublicFileRecord[];
    readonly size_gate: SizeGate;
  };
  readonly runtime: RuntimeHealthSummary;
}

interface OutputCapture {
  stdout: string;
  stderr: string;
}

interface ChildState {
  exited: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface WaitForJsonOptions {
  readonly state: ChildState;
  readonly output: OutputCapture;
  readonly timeoutMs: number;
}

interface ParsedArgs {
  output?: string;
  bundleRoot?: string;
  sidecarDir?: string;
  ocrRuntimeRoot?: string;
  ocrRuntimeManifest?: string;
  expectedTargetTriple?: string;
  healthTimeoutMs?: number;
}

type JsonRecord = Record<string, unknown>;

export async function createPackageQaReport(
  options: PackageQaOptions = {}
): Promise<PackageQaReport> {
  const workspaceRoot = resolve(options.workspaceRoot ?? defaultWorkspaceRoot);
  const bundleRoot = resolve(workspaceRoot, options.bundleRoot ?? DEFAULT_BUNDLE_ROOT);
  const sidecarDir = resolve(workspaceRoot, options.sidecarDir ?? DEFAULT_SIDECAR_DIR);
  const ocrRuntimeRoot = resolve(
    workspaceRoot,
    options.ocrRuntimeRoot ?? DEFAULT_OCR_RUNTIME_ROOT
  );
  const ocrRuntimeManifest = resolve(
    workspaceRoot,
    options.ocrRuntimeManifest ?? DEFAULT_OCR_RUNTIME_MANIFEST
  );
  const expectedTargetTriple =
    options.expectedTargetTriple ?? DEFAULT_TARGET_TRIPLE;

  const bundleArtifacts = collectBundleArtifacts(bundleRoot, workspaceRoot);
  if (bundleArtifacts.length === 0) {
    throw new Error(`No bundle artifacts found under ${bundleRoot}`);
  }

  const sidecars = collectSidecars(sidecarDir, workspaceRoot);
  const sidecar = resolveSingleSidecar(sidecars);
  const targetTriple = targetTripleFromSidecarName(basename(sidecar.absolutePath));
  if (targetTriple !== expectedTargetTriple) {
    throw new Error(
      `Expected ${expectedTargetTriple} sidecar, found ${targetTriple}`
    );
  }

  const runtime = await collectRuntimeHealth({
    sidecarPath: sidecar.absolutePath,
    workspaceRoot,
    timeoutMs: options.healthTimeoutMs,
    dataDir: resolve(workspaceRoot, options.dataDir ?? DEFAULT_DATA_DIR),
    llmModel: options.llmModel ?? DEFAULT_LLM_MODEL,
    ocrRuntimeManifest,
  });
  const ocrRuntimeArtifacts = collectOcrRuntimeArtifacts(ocrRuntimeRoot, workspaceRoot);
  const sizeGate = initialInstallerSizeGate(bundleArtifacts, sidecar);
  if (sizeGate.status === 'failed') {
    throw new Error(sizeGate.detail);
  }

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    target: {
      rust_triple: targetTriple,
      platform: process.platform,
      arch: process.arch,
    },
    package: {
      bundle_root: normalizePath(relative(workspaceRoot, bundleRoot)),
      bundle_artifacts: bundleArtifacts.map(publicFileRecord),
      sidecar: publicFileRecord(sidecar),
      ocr_runtime_root: normalizePath(relative(workspaceRoot, ocrRuntimeRoot)),
      ocr_runtime_artifacts: ocrRuntimeArtifacts.map(publicFileRecord),
      size_gate: sizeGate,
    },
    runtime,
  };
}

export function collectBundleArtifacts(
  bundleRoot: string,
  workspaceRoot = defaultWorkspaceRoot
): FileRecord[] {
  if (!existsSync(bundleRoot)) {
    return [];
  }
  return collectFiles(bundleRoot, workspaceRoot);
}

export function collectSidecars(
  sidecarDir: string,
  workspaceRoot = defaultWorkspaceRoot
): FileRecord[] {
  if (!existsSync(sidecarDir)) {
    return [];
  }
  return collectFiles(sidecarDir, workspaceRoot).filter(record =>
    isSidecarName(basename(record.absolutePath))
  );
}

export function collectOcrRuntimeArtifacts(
  ocrRuntimeRoot: string,
  workspaceRoot = defaultWorkspaceRoot
): FileRecord[] {
  if (!existsSync(ocrRuntimeRoot)) {
    return [];
  }
  return collectFiles(ocrRuntimeRoot, workspaceRoot);
}

export function resolveSingleSidecar(sidecars: readonly FileRecord[]): FileRecord {
  if (sidecars.length !== 1) {
    const paths = sidecars.map(sidecar => sidecar.path).join(', ') || 'none';
    throw new Error(`Expected exactly one synced sidecar, found ${paths}`);
  }
  return sidecars[0];
}

export function targetTripleFromSidecarName(fileName: string): string {
  if (!isSidecarName(fileName)) {
    throw new Error(`Not an exam-prep sidecar name: ${fileName}`);
  }
  const withoutPrefix = fileName.slice(SIDECAR_PREFIX.length);
  return withoutPrefix.endsWith('.exe')
    ? withoutPrefix.slice(0, -'.exe'.length)
    : withoutPrefix;
}

export function summarizeOcrHealth(health: JsonRecord): OcrHealthSummary {
  return {
    provider: health.provider ?? null,
    engine: health.engine ?? null,
    available: health.available ?? null,
    detail: health.detail ?? null,
    selected_device: health.selected_device ?? null,
    cuda_available: health.cuda_available ?? null,
    gpu_count: health.gpu_count ?? null,
    fallback_reason: health.fallback_reason ?? null,
    unavailable_reason: health.unavailable_reason ?? null,
  };
}

export function summarizeLlmHealth(health: JsonRecord): LlmHealthSummary {
  return {
    provider: health.provider ?? null,
    model: health.model ?? null,
    available: health.available ?? null,
    detail: health.detail ?? null,
    unavailable_reason: health.unavailable_reason ?? null,
  };
}

export function bytesToMb(bytes: number): number {
  return Number((bytes / 1024 / 1024).toFixed(2));
}

export async function collectRuntimeHealth({
  sidecarPath,
  workspaceRoot = defaultWorkspaceRoot,
  timeoutMs = 120_000,
  dataDir = resolve(workspaceRoot, DEFAULT_DATA_DIR),
  llmModel = DEFAULT_LLM_MODEL,
  ocrRuntimeManifest = resolve(workspaceRoot, DEFAULT_OCR_RUNTIME_MANIFEST),
}: RuntimeHealthOptions = {} as RuntimeHealthOptions): Promise<RuntimeHealthSummary> {
  const port = await reserveLoopbackPort();
  const token = `package-qa-${process.pid}-${Date.now()}`;
  const baseUrl = `http://127.0.0.1:${port}`;
  const output: OutputCapture = { stdout: '', stderr: '' };
  const state: ChildState = { exited: false, code: null, signal: null };

  mkdirSync(dataDir, { recursive: true });

  const child = spawn(sidecarPath, [], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      EXAM_PREP_HOST: '127.0.0.1',
      EXAM_PREP_PORT: String(port),
      EXAM_PREP_API_TOKEN: token,
      EXAM_PREP_DATA_DIR: dataDir,
      EXAM_PREP_LLM_PROVIDER: 'ollama',
      EXAM_PREP_OCR_PROVIDER: 'paddle',
      EXAM_PREP_OCR_RUNTIME_MODE: 'external',
      EXAM_PREP_OCR_RUNTIME_MANIFEST_PATH: ocrRuntimeManifest,
      EXAM_PREP_OCR_DEVICE: 'auto',
      EXAM_PREP_OLLAMA_MODEL: llmModel,
      PYTHONIOENCODING: 'utf-8',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout?.on('data', chunk => appendCapture(output, 'stdout', chunk));
  child.stderr?.on('data', chunk => appendCapture(output, 'stderr', chunk));
  child.on('exit', (code, signal) => {
    state.exited = true;
    state.code = code;
    state.signal = signal;
  });

  try {
    const systemHealth = await waitForJson(`${baseUrl}/health`, {
      state,
      output,
      timeoutMs,
    });
    const ocrHealthRaw = asJsonRecord(await fetchJson(`${baseUrl}/ocr/health`, token));
    const llmHealthRaw = asJsonRecord(await fetchJson(`${baseUrl}/llm/health`, token));

    return {
      launch_env: {
        EXAM_PREP_OCR_PROVIDER: 'paddle',
        EXAM_PREP_OCR_RUNTIME_MODE: 'external',
        EXAM_PREP_OCR_DEVICE: 'auto',
        EXAM_PREP_LLM_PROVIDER: 'ollama',
        EXAM_PREP_OLLAMA_MODEL: llmModel,
      },
      system_health: systemHealth,
      ocr_health: summarizeOcrHealth(ocrHealthRaw),
      llm_health: summarizeLlmHealth(llmHealthRaw),
      raw_health: {
        ocr: ocrHealthRaw,
        llm: llmHealthRaw,
      },
      sidecar_output_tail: output,
    };
  } finally {
    await stopChild(child, state);
  }
}

export function initialInstallerSizeGate(
  bundleArtifacts: readonly Pick<FileRecord, 'mb'>[],
  sidecar: Pick<FileRecord, 'mb'>
): SizeGate {
  const largestInitialMb = Math.max(
    sidecar.mb,
    ...bundleArtifacts.map(artifact => artifact.mb)
  );
  if (largestInitialMb > INITIAL_INSTALLER_ERROR_MB) {
    return {
      status: 'failed',
      largest_initial_mb: largestInitialMb,
      warning_mb: INITIAL_INSTALLER_WARNING_MB,
      error_mb: INITIAL_INSTALLER_ERROR_MB,
      detail:
        `Initial package is ${largestInitialMb} MB, above the ${INITIAL_INSTALLER_ERROR_MB} MB limit.`,
    };
  }
  if (largestInitialMb > INITIAL_INSTALLER_WARNING_MB) {
    return {
      status: 'warning',
      largest_initial_mb: largestInitialMb,
      warning_mb: INITIAL_INSTALLER_WARNING_MB,
      error_mb: INITIAL_INSTALLER_ERROR_MB,
      detail:
        `Initial package is ${largestInitialMb} MB, above the ${INITIAL_INSTALLER_WARNING_MB} MB warning threshold.`,
    };
  }
  return {
    status: 'passed',
    largest_initial_mb: largestInitialMb,
    warning_mb: INITIAL_INSTALLER_WARNING_MB,
    error_mb: INITIAL_INSTALLER_ERROR_MB,
    detail: 'Initial package size is within the configured gate.',
  };
}

export function writeReport(report: unknown, outputPath: string): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}

function collectFiles(root: string, workspaceRoot: string): FileRecord[] {
  const files: FileRecord[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(path, workspaceRoot));
    } else if (entry.isFile()) {
      files.push(fileRecord(path, workspaceRoot));
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function fileRecord(filePath: string, workspaceRoot: string): FileRecord {
  const bytes = statSync(filePath).size;
  return {
    absolutePath: filePath,
    path: normalizePath(relative(workspaceRoot, filePath)),
    bytes,
    mb: bytesToMb(bytes),
  };
}

function publicFileRecord(record: FileRecord): PublicFileRecord {
  return {
    path: record.path,
    bytes: record.bytes,
    mb: record.mb,
  };
}

function isSidecarName(fileName: string): boolean {
  return (
    fileName.startsWith(SIDECAR_PREFIX) &&
    fileName.length > SIDECAR_PREFIX.length &&
    (fileName.endsWith('.exe') || !fileName.includes('.'))
  );
}

function normalizePath(path: string): string {
  return path.split(sep).join('/');
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close(error => (error ? rejectClose(error) : resolveClose()));
  });
  if (!port) {
    throw new Error('Unable to reserve a loopback port for package QA.');
  }
  return port;
}

async function waitForJson(
  url: string,
  { state, output, timeoutMs }: WaitForJsonOptions
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    if (state.exited) {
      throw new Error(
        `Sidecar exited before health was ready (code=${state.code}, signal=${state.signal}). stderr tail: ${output.stderr}`
      );
    }
    try {
      return await fetchJson(url);
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw new Error(
    `Sidecar did not become healthy within ${timeoutMs}ms. Last error: ${errorMessage(lastError)}`
  );
}

async function fetchJson(url: string, token?: string): Promise<unknown> {
  const headers: Record<string, string> = token
    ? { Authorization: `Bearer ${token}` }
    : {};
  const response = await fetch(url, { headers });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${url} returned invalid JSON: ${errorMessage(error)}`);
  }
}

function appendCapture(output: OutputCapture, key: keyof OutputCapture, chunk: Buffer | string): void {
  output[key] = `${output[key]}${chunk.toString()}`.slice(-CAPTURE_LIMIT);
}

async function stopChild(child: ChildProcess, state: ChildState): Promise<void> {
  if (state.exited) {
    return;
  }
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
    });
  } else {
    child.kill();
  }
  await Promise.race([once(child, 'exit'), delay(5_000)]);
  if (!state.exited) {
    child.kill('SIGKILL');
  }
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const readValue = (name: string): string => {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`${name} requires a value.`);
      }
      index += 1;
      return value;
    };

    if (arg === '--output') {
      parsed.output = readValue(arg);
    } else if (arg === '--bundle-root') {
      parsed.bundleRoot = readValue(arg);
    } else if (arg === '--sidecar-dir') {
      parsed.sidecarDir = readValue(arg);
    } else if (arg === '--ocr-runtime-root') {
      parsed.ocrRuntimeRoot = readValue(arg);
    } else if (arg === '--ocr-runtime-manifest') {
      parsed.ocrRuntimeManifest = readValue(arg);
    } else if (arg === '--target') {
      parsed.expectedTargetTriple = readValue(arg);
    } else if (arg === '--health-timeout-ms') {
      parsed.healthTimeoutMs = Number(readValue(arg));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function asJsonRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'none');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const workspaceRoot = defaultWorkspaceRoot;
  const outputPath = resolve(workspaceRoot, args.output ?? DEFAULT_OUTPUT);
  const report = await createPackageQaReport({ ...args, workspaceRoot });
  writeReport(report, outputPath);
  console.log(`Wrote package QA report to ${outputPath}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
