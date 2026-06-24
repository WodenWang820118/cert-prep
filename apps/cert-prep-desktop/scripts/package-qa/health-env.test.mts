import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { parsePackageQaArgs, parsePackageQaEnv } from './cli.mts';
import {
  buildRuntimeLaunchEnv,
  collectRuntimeHealth,
  summarizeLlmHealth,
  summarizeOcrHealth,
} from './health.mts';
import { initialInstallerSizeGate } from './size-gate.mts';

test('health summaries keep OCR fallback and LLM model state', () => {
  assert.deepEqual(
    summarizeOcrHealth({
      provider: 'paddle',
      engine: 'paddleocr',
      available: true,
      detail: 'ready',
      selected_device: 'cpu',
      cuda_available: false,
      gpu_count: 0,
      fallback_reason: 'cuda_unavailable',
      extra: 'ignored',
    }),
    {
      provider: 'paddle',
      engine: 'paddleocr',
      available: true,
      detail: 'ready',
      selected_device: 'cpu',
      cuda_available: false,
      gpu_count: 0,
      fallback_reason: 'cuda_unavailable',
      unavailable_reason: null,
    },
  );

  assert.deepEqual(
    summarizeLlmHealth({
      provider: 'ollama',
      model: 'qwen3.5:4b',
      available: false,
      detail: 'model not found',
      extra: 'ignored',
    }),
    {
      provider: 'ollama',
      model: 'qwen3.5:4b',
      available: false,
      detail: 'model not found',
      unavailable_reason: null,
    },
  );
});

test('package QA parses OCR page worker count from QA-specific inputs', () => {
  assert.deepEqual(
    parsePackageQaEnv({
      CERT_PREP_PACKAGE_QA_LLM_PROVIDER: 'ollama',
      CERT_PREP_PACKAGE_QA_OCR_PAGE_WORKERS: '2',
    }),
    { llmProvider: 'ollama', ocrPageWorkers: 2 },
  );
  assert.equal(
    parsePackageQaArgs(['--llm-provider', 'fastflowlm', '--ocr-page-workers', '4'], {
      CERT_PREP_PACKAGE_QA_OCR_PAGE_WORKERS: '2',
    }).llmProvider,
    'fastflowlm',
  );
  assert.equal(
    parsePackageQaArgs(['--llm-provider', 'fastflowlm', '--ocr-page-workers', '4'], {
      CERT_PREP_PACKAGE_QA_OCR_PAGE_WORKERS: '2',
    }).ocrPageWorkers,
    4,
  );
  assert.throws(
    () => parsePackageQaArgs(['--ocr-page-workers', '0'], {}),
    /positive integer/,
  );
});

test('runtime launch env sets OCR page workers only from explicit QA config', () => {
  const baseOptions = {
    port: 8765,
    token: 'token',
    dataDir: 'data',
    llmModel: 'qwen3.5:4b',
    windowsmlOcrRuntimeManifest: 'windowsml-ocr-runtime-manifest.json',
  };

  const ambientOnly = buildRuntimeLaunchEnv({
    ...baseOptions,
    baseEnv: { CERT_PREP_OCR_PAGE_WORKERS: '9', PATH: 'test-path' },
  });
  assert.equal(ambientOnly.CERT_PREP_OCR_PAGE_WORKERS, undefined);
  assert.equal(
    ambientOnly.CERT_PREP_STREAMING_DRAFT_GENERATION_ON_UPLOAD,
    'true',
  );
  assert.equal(ambientOnly.CERT_PREP_OCR_PROVIDER, 'windowsml');
  assert.equal(ambientOnly.CERT_PREP_LLM_PROVIDER, 'fastflowlm');
  assert.equal(ambientOnly.CERT_PREP_FASTFLOWLM_MODEL, 'qwen3.5:4b');
  assert.equal(
    ambientOnly.CERT_PREP_WINDOWSML_OCR_RUNTIME_MANIFEST_PATH,
    'windowsml-ocr-runtime-manifest.json',
  );
  assert.equal('CERT_PREP_OCR_RUNTIME_MANIFEST_PATH' in ambientOnly, false);
  assert.equal(ambientOnly.CERT_PREP_OCR_WINDOWSML_DEVICE_ID, '-1');
  assert.equal(ambientOnly.PATH, 'test-path');

  const explicit = buildRuntimeLaunchEnv({
    ...baseOptions,
    llmProvider: 'ollama',
    ocrPageWorkers: 3,
    baseEnv: { CERT_PREP_OCR_PAGE_WORKERS: '9' },
  });
  assert.equal(explicit.CERT_PREP_LLM_PROVIDER, 'ollama');
  assert.equal(explicit.CERT_PREP_OCR_PAGE_WORKERS, '3');
});

test('runtime health reports cleanup for launched backend child', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cert-prep-package-qa-'));
  try {
    const scriptPath = writeBackendFixture(dir, `
import http from 'node:http';
const port = Number(process.env.CERT_PREP_PORT);
const payloads = {
  '/health': { status: 'ok' },
  '/ocr/health': { provider: 'windowsml', engine: 'test', available: true },
  '/llm/health': { provider: 'fastflowlm', model: 'test', available: true },
};
http.createServer((request, response) => {
  const payload = payloads[request.url] ?? { status: 'not_found' };
  response.writeHead(payload.status === 'not_found' ? 404 : 200, {
    'content-type': 'application/json',
  });
  response.end(JSON.stringify(payload));
}).listen(port, '127.0.0.1');
`);

    const runtime = await collectRuntimeHealth({
      backendRuntimeEntrypoint: process.execPath,
      backendRuntimeArgs: [scriptPath],
      workspaceRoot: dir,
      dataDir: join(dir, 'data'),
      windowsmlOcrRuntimeManifest: join(dir, 'windowsml-ocr-runtime-manifest.json'),
      timeoutMs: 5_000,
    });

    assert.deepEqual(runtime.system_health, { status: 'ok' });
    assert.equal(runtime.cleanup.backend_process?.label, 'package-qa-backend-runtime');
    assert.equal(runtime.cleanup.backend_process?.attempted, true);
    assert.match(
      runtime.cleanup.backend_process?.method ?? '',
      /^(taskkill_process_tree|signal_process)$/,
    );
    assert.equal(runtime.cleanup.backend_process?.stopped, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime health timeout still stops launched backend child', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cert-prep-package-qa-timeout-'));
  const pidPath = join(dir, 'backend.pid');
  try {
    const scriptPath = writeBackendFixture(dir, `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
setInterval(() => {}, 1000);
`);

    await assert.rejects(
      collectRuntimeHealth({
        backendRuntimeEntrypoint: process.execPath,
        backendRuntimeArgs: [scriptPath],
        workspaceRoot: dir,
        dataDir: join(dir, 'data'),
        windowsmlOcrRuntimeManifest: join(dir, 'windowsml-ocr-runtime-manifest.json'),
        timeoutMs: 500,
      }),
      /Backend runtime did not become healthy/,
    );

    const pid = Number(readFileSync(pidPath, 'utf8'));
    assert.equal(isProcessRunning(pid), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('initialInstallerSizeGate warns and fails at configured thresholds', () => {
  assert.equal(initialInstallerSizeGate([{ mb: 100 }]).status, 'passed');
  assert.equal(initialInstallerSizeGate([{ mb: 180 }]).status, 'warning');
  assert.equal(initialInstallerSizeGate([{ mb: 300 }]).status, 'failed');
});

function writeBackendFixture(dir: string, script: string): string {
  const scriptPath = join(dir, 'backend-fixture.mjs');
  writeFileSync(scriptPath, script, 'utf8');
  return scriptPath;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
