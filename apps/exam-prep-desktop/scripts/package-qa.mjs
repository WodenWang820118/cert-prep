import { spawn, spawnSync } from 'node:child_process';
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
const DEFAULT_DATA_DIR = 'tmp/exam-prep-desktop/package-qa/data';
const DEFAULT_LLM_MODEL = 'gemma4:12b';
const SIDECAR_PREFIX = 'exam-prep-backend-';
const CAPTURE_LIMIT = 12_000;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultWorkspaceRoot = resolve(scriptDir, '../../..');

export async function createPackageQaReport(options = {}) {
  const workspaceRoot = resolve(options.workspaceRoot ?? defaultWorkspaceRoot);
  const bundleRoot = resolve(workspaceRoot, options.bundleRoot ?? DEFAULT_BUNDLE_ROOT);
  const sidecarDir = resolve(workspaceRoot, options.sidecarDir ?? DEFAULT_SIDECAR_DIR);
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
  });

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
    },
    runtime,
  };
}

export function collectBundleArtifacts(bundleRoot, workspaceRoot = defaultWorkspaceRoot) {
  if (!existsSync(bundleRoot)) {
    return [];
  }
  return collectFiles(bundleRoot, workspaceRoot);
}

export function collectSidecars(sidecarDir, workspaceRoot = defaultWorkspaceRoot) {
  if (!existsSync(sidecarDir)) {
    return [];
  }
  return collectFiles(sidecarDir, workspaceRoot).filter(record =>
    isSidecarName(basename(record.absolutePath))
  );
}

export function resolveSingleSidecar(sidecars) {
  if (sidecars.length !== 1) {
    const paths = sidecars.map(sidecar => sidecar.path).join(', ') || 'none';
    throw new Error(`Expected exactly one synced sidecar, found ${paths}`);
  }
  return sidecars[0];
}

export function targetTripleFromSidecarName(fileName) {
  if (!isSidecarName(fileName)) {
    throw new Error(`Not an exam-prep sidecar name: ${fileName}`);
  }
  const withoutPrefix = fileName.slice(SIDECAR_PREFIX.length);
  return withoutPrefix.endsWith('.exe')
    ? withoutPrefix.slice(0, -'.exe'.length)
    : withoutPrefix;
}

export function summarizeOcrHealth(health) {
  return {
    provider: health.provider ?? null,
    engine: health.engine ?? null,
    available: health.available ?? null,
    detail: health.detail ?? null,
    selected_device: health.selected_device ?? null,
    cuda_available: health.cuda_available ?? null,
    gpu_count: health.gpu_count ?? null,
    fallback_reason: health.fallback_reason ?? null,
  };
}

export function summarizeLlmHealth(health) {
  return {
    provider: health.provider ?? null,
    model: health.model ?? null,
    available: health.available ?? null,
    detail: health.detail ?? null,
  };
}

export function bytesToMb(bytes) {
  return Number((bytes / 1024 / 1024).toFixed(2));
}

export async function collectRuntimeHealth({
  sidecarPath,
  workspaceRoot = defaultWorkspaceRoot,
  timeoutMs = 120_000,
  dataDir = resolve(workspaceRoot, DEFAULT_DATA_DIR),
  llmModel = DEFAULT_LLM_MODEL,
} = {}) {
  const port = await reserveLoopbackPort();
  const token = `package-qa-${process.pid}-${Date.now()}`;
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = { stdout: '', stderr: '' };
  const state = { exited: false, code: null, signal: null };

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
    const ocrHealthRaw = await fetchJson(`${baseUrl}/ocr/health`, token);
    const llmHealthRaw = await fetchJson(`${baseUrl}/llm/health`, token);

    return {
      launch_env: {
        EXAM_PREP_OCR_PROVIDER: 'paddle',
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

export function writeReport(report, outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}

function collectFiles(root, workspaceRoot) {
  const files = [];
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

function fileRecord(filePath, workspaceRoot) {
  const bytes = statSync(filePath).size;
  return {
    absolutePath: filePath,
    path: normalizePath(relative(workspaceRoot, filePath)),
    bytes,
    mb: bytesToMb(bytes),
  };
}

function publicFileRecord(record) {
  return {
    path: record.path,
    bytes: record.bytes,
    mb: record.mb,
  };
}

function isSidecarName(fileName) {
  return (
    fileName.startsWith(SIDECAR_PREFIX) &&
    fileName.length > SIDECAR_PREFIX.length &&
    (fileName.endsWith('.exe') || !fileName.includes('.'))
  );
}

function normalizePath(path) {
  return path.split(sep).join('/');
}

async function reserveLoopbackPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  await new Promise((resolveClose, rejectClose) => {
    server.close(error => (error ? rejectClose(error) : resolveClose()));
  });
  if (!port) {
    throw new Error('Unable to reserve a loopback port for package QA.');
  }
  return port;
}

async function waitForJson(url, { state, output, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
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
    `Sidecar did not become healthy within ${timeoutMs}ms. Last error: ${lastError?.message ?? 'none'}`
  );
}

async function fetchJson(url, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await fetch(url, { headers });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${url} returned invalid JSON: ${error.message}`);
  }
}

function appendCapture(output, key, chunk) {
  output[key] = `${output[key]}${chunk.toString()}`.slice(-CAPTURE_LIMIT);
}

async function stopChild(child, state) {
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

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const readValue = name => {
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

async function main() {
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
