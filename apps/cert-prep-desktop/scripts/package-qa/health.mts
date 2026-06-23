import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  CAPTURE_LIMIT,
  DEFAULT_DATA_DIR,
  DEFAULT_WINDOWSML_OCR_RUNTIME_MANIFEST,
  DEFAULT_LLM_MODEL,
  defaultWorkspaceRoot,
} from './constants.mts';
import {
  asJsonRecord,
  errorMessage,
  positiveInteger,
} from './validation.mts';
import type {
  ChildState,
  JsonRecord,
  LlmHealthSummary,
  OcrHealthSummary,
  OutputCapture,
  RuntimeHealthOptions,
  RuntimeHealthSummary,
  RuntimeLaunchEnvOptions,
  WaitForJsonOptions,
} from './types.mts';

/** Summarizes OCR health into the stable package QA report shape. */
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

/** Summarizes LLM health into the stable package QA report shape. */
export function summarizeLlmHealth(health: JsonRecord): LlmHealthSummary {
  return {
    provider: health.provider ?? null,
    model: health.model ?? null,
    available: health.available ?? null,
    detail: health.detail ?? null,
    unavailable_reason: health.unavailable_reason ?? null,
  };
}

/** Launches the packaged backend and collects health endpoints for the report. */
export async function collectRuntimeHealth({
  backendRuntimeEntrypoint,
  workspaceRoot = defaultWorkspaceRoot,
  timeoutMs = 120_000,
  dataDir = resolve(workspaceRoot, DEFAULT_DATA_DIR),
  llmModel = DEFAULT_LLM_MODEL,
  windowsmlOcrRuntimeManifest = resolve(
    workspaceRoot,
    DEFAULT_WINDOWSML_OCR_RUNTIME_MANIFEST,
  ),
  ocrProvider = 'windowsml',
  ocrPageWorkers,
}: RuntimeHealthOptions): Promise<RuntimeHealthSummary> {
  const port = await reserveLoopbackPort();
  const token = `package-qa-${process.pid}-${Date.now()}`;
  const baseUrl = `http://127.0.0.1:${port}`;
  const output: OutputCapture = { stdout: '', stderr: '' };
  const state: ChildState = { exited: false, code: null, signal: null };

  mkdirSync(dataDir, { recursive: true });
  const childEnv = buildRuntimeLaunchEnv({
    port,
    token,
    dataDir,
    llmModel,
    windowsmlOcrRuntimeManifest,
    ocrProvider,
    ocrPageWorkers,
  });

  const child = spawn(backendRuntimeEntrypoint, [], {
    cwd: workspaceRoot,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout?.on('data', (chunk) => appendCapture(output, 'stdout', chunk));
  child.stderr?.on('data', (chunk) => appendCapture(output, 'stderr', chunk));
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
    const ocrHealthRaw = asJsonRecord(
      await fetchJson(`${baseUrl}/ocr/health`, token),
    );
    const llmHealthRaw = asJsonRecord(
      await fetchJson(`${baseUrl}/llm/health`, token),
    );

    return {
      launch_env: {
        CERT_PREP_OCR_PROVIDER: ocrProvider,
        CERT_PREP_OCR_RUNTIME_MODE: 'external',
        CERT_PREP_OCR_DEVICE: 'auto',
        CERT_PREP_OCR_WINDOWSML_DEVICE_ID: '-1',
        CERT_PREP_OCR_WINDOWSML_DEVICE_POLICY: 'PREFER_NPU',
        CERT_PREP_WINDOWSML_OCR_RUNTIME_MANIFEST_PATH:
          windowsmlOcrRuntimeManifest,
        CERT_PREP_LLM_PROVIDER: 'ollama',
        CERT_PREP_OLLAMA_MODEL: llmModel,
        CERT_PREP_STREAMING_DRAFT_GENERATION_ON_UPLOAD: 'true',
        CERT_PREP_OCR_PAGE_WORKERS:
          childEnv.CERT_PREP_OCR_PAGE_WORKERS ?? null,
      },
      system_health: systemHealth,
      ocr_health: summarizeOcrHealth(ocrHealthRaw),
      llm_health: summarizeLlmHealth(llmHealthRaw),
      raw_health: {
        ocr: ocrHealthRaw,
        llm: llmHealthRaw,
      },
      backend_output_tail: output,
    };
  } finally {
    await stopChild(child, state);
  }
}

/** Builds the controlled environment used to launch the packaged backend. */
export function buildRuntimeLaunchEnv({
  port,
  token,
  dataDir,
  llmModel,
  windowsmlOcrRuntimeManifest,
  ocrProvider = 'windowsml',
  ocrPageWorkers,
  baseEnv = process.env,
}: RuntimeLaunchEnvOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  delete env.CERT_PREP_OCR_PAGE_WORKERS;
  Object.assign(env, {
    CERT_PREP_HOST: '127.0.0.1',
    CERT_PREP_PORT: String(port),
    CERT_PREP_API_TOKEN: token,
    CERT_PREP_DATA_DIR: dataDir,
    CERT_PREP_LLM_PROVIDER: 'ollama',
    CERT_PREP_OCR_PROVIDER: ocrProvider,
    CERT_PREP_OCR_RUNTIME_MODE: 'external',
    CERT_PREP_OCR_DEVICE: 'auto',
    CERT_PREP_WINDOWSML_OCR_RUNTIME_MANIFEST_PATH:
      windowsmlOcrRuntimeManifest,
    CERT_PREP_OCR_WINDOWSML_DEVICE_ID: '-1',
    CERT_PREP_OCR_WINDOWSML_DEVICE_POLICY: 'PREFER_NPU',
    CERT_PREP_OLLAMA_MODEL: llmModel,
    CERT_PREP_STREAMING_DRAFT_GENERATION_ON_UPLOAD: 'true',
    PYTHONIOENCODING: 'utf-8',
  });
  if (ocrPageWorkers !== undefined) {
    env.CERT_PREP_OCR_PAGE_WORKERS = String(
      positiveInteger(ocrPageWorkers, 'ocrPageWorkers'),
    );
  }
  return env;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
  if (!port) {
    throw new Error('Unable to reserve a loopback port for package QA.');
  }
  return port;
}

async function waitForJson(
  url: string,
  { state, output, timeoutMs }: WaitForJsonOptions,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    if (state.exited) {
      throw new Error(
        `Backend runtime exited before health was ready (code=${state.code}, signal=${state.signal}). stderr tail: ${output.stderr}`,
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
    `Backend runtime did not become healthy within ${timeoutMs}ms. Last error: ${errorMessage(lastError)}`,
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

function appendCapture(
  output: OutputCapture,
  key: keyof OutputCapture,
  chunk: Buffer | string,
): void {
  output[key] = `${output[key]}${chunk.toString()}`.slice(-CAPTURE_LIMIT);
}

async function stopChild(
  child: ChildProcess,
  state: ChildState,
): Promise<void> {
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
